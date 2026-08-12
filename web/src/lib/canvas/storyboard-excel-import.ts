import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import type { StoryboardRow, StoryboardColumn } from "@/types/canvas";

/**
 * 分镜脚本 Excel 导入解析库
 *
 * 支持通过模糊匹配表头来自动映射 Excel 列到分镜表格字段。
 * 用户无需严格按模板填写，表头名称接近即可自动识别。
 */

// 可导入的 StoryboardRow 字段列表（排除 id, characters, mustHave 等内部管理字段）
const IMPORTABLE_FIELDS = [
    "shotNumber",
    "durationSeconds",
    "plotDescription",
    "dialogue",
    "narrativeIntent",
    "viewerPOV",
    "performanceBlocking",
    "shotSize",
    "emotion",
    "lightingAndAtmosphere",
    "audioEffects",
    "camera",
    "motion",
    "timeBeats",
    "imageGenerationPrompt",
    "videoMotionPrompt",
    "continuityOut",
    "negativePrompt",
] as const;

type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

export type { ImportableField };

// 中文字段名 → StoryboardRow key 的映射表（按优先级排列）
const COLUMN_KEYWORDS: Record<ImportableField, string[]> = {
    shotNumber: ["序号", "镜号", "镜头号", "镜头编号", "shotnumber", "shot number"],
    durationSeconds: ["时长", "时间", "秒数", "duration", "seconds"],
    plotDescription: ["画面描述", "画面内容", "描述", "画面", "plot"],
    dialogue: ["台词", "旁白", "台词旁白", "对白", "dialogue"],
    narrativeIntent: ["镜头意图", "叙事意图", "意图", "narrative"],
    viewerPOV: ["观众视点", "视角", "视点", "pov"],
    performanceBlocking: ["表演调度", "调度", "blocking"],
    shotSize: ["景别", "shotsize", "shot size"],
    emotion: ["情绪", "emotion"],
    lightingAndAtmosphere: ["光影氛围", "光影", "氛围", "lighting"],
    audioEffects: ["音效", "声音", "audio", "sound"],
    camera: ["镜头设计", "镜头", "机位", "camera"],
    motion: ["运镜", "运动", "镜头运动", "motion"],
    timeBeats: ["时间节拍", "节拍", "timebeats", "beats"],
    imageGenerationPrompt: ["图片提示词", "图片prompt", "图片prompt", "imageprompt", "image prompt", "图片提示"],
    videoMotionPrompt: ["视频提示词", "视频prompt", "视频prompt", "videoprompt", "video prompt", "视频提示"],
    continuityOut: ["连续性出口", "出口", "continuity"],
    negativePrompt: ["负面要求", "负面prompt", "负面prompt", "negative", "负面"],
};

// 所有可导入字段的中文标签（用于映射弹窗和模板）
export const IMPORTABLE_FIELD_LABELS: Record<ImportableField, string> = {
    shotNumber: "序号",
    durationSeconds: "时长",
    plotDescription: "画面描述",
    dialogue: "台词/旁白",
    narrativeIntent: "镜头意图",
    viewerPOV: "观众视点",
    performanceBlocking: "表演调度",
    shotSize: "景别",
    emotion: "情绪",
    lightingAndAtmosphere: "光影氛围",
    audioEffects: "音效",
    camera: "镜头设计",
    motion: "运镜",
    timeBeats: "时间节拍",
    imageGenerationPrompt: "图片提示词",
    videoMotionPrompt: "视频提示词",
    continuityOut: "连续性出口",
    negativePrompt: "负面要求",
};

export type ExcelImportMapping = Record<number, ImportableField | null>;

export type ExcelImportResult = {
    /** 解析出的原始行数据（二维数组，含表头） */
    rawRows: string[][];
    /** 表头行 */
    headers: string[];
    /** 自动生成的字段映射：列索引 → 字段名（null 表示未识别） */
    mapping: ExcelImportMapping;
    /** 未识别的表头列名 */
    unmappedHeaders: string[];
    /** 解析出的分镜行（基于自动映射） */
    rows: StoryboardRow[];
    /** 警告信息 */
    warnings: string[];
    /** 是否有至少一列映射到了 plotDescription */
    hasPlotDescription: boolean;
};

/**
 * 模糊匹配表头到一个 StoryboardRow 字段
 * 匹配规则：表头转小写后，包含关键词中的任意一个即命中
 */
function matchHeader(header: string): ImportableField | null {
    const normalized = header.trim().toLowerCase();
    if (!normalized) return null;

    // 优先精确匹配字段英文名
    for (const field of IMPORTABLE_FIELDS) {
        if (normalized === field.toLowerCase()) return field;
    }

    // 关键词包含匹配
    for (const field of IMPORTABLE_FIELDS) {
        const keywords = COLUMN_KEYWORDS[field];
        if (keywords.some((kw) => normalized.includes(kw.toLowerCase()))) {
            return field;
        }
    }

    return null;
}

/**
 * 解析 Excel 文件并返回导入预览数据
 */
export async function parseStoryboardExcel(file: File): Promise<ExcelImportResult> {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
        throw new Error("Excel 文件不包含任何工作表");
    }
    const sheet = workbook.Sheets[firstSheetName];
    // header: 1 返回二维数组，第一行是表头
    const rawRows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" });

    if (rawRows.length < 2) {
        throw new Error("Excel 文件至少需要表头行和一行数据");
    }

    const headers = rawRows[0].map((h) => String(h || "").trim());
    const dataRows = rawRows.slice(1).filter((row) => row.some((cell) => String(cell || "").trim() !== ""));

    // 自动映射
    const mapping: ExcelImportMapping = {};
    const unmappedHeaders: string[] = [];
    let hasPlotDescription = false;

    headers.forEach((header, index) => {
        const field = matchHeader(header);
        mapping[index] = field;
        if (field) {
            if (field === "plotDescription") hasPlotDescription = true;
        } else if (header) {
            unmappedHeaders.push(header);
        }
    });

    // 基于自动映射生成预览行
    const warnings: string[] = [];
    const rows: StoryboardRow[] = dataRows.map((rawRow, rowIndex) => {
        const values: Partial<StoryboardRow> = {};
        Object.entries(mapping).forEach(([colIndex, field]) => {
            if (!field) return;
            const rawValue = String(rawRow[Number(colIndex)] || "").trim();
            if (field === "durationSeconds") {
                const num = Number(rawValue);
                values.durationSeconds = isNaN(num) ? 6 : Math.min(60, Math.max(1, Math.round(num)));
            } else if (field === "shotNumber") {
                const num = Number(rawValue);
                values.shotNumber = isNaN(num) ? rowIndex + 1 : Math.round(num);
            } else {
                (values as Record<string, string>)[field] = rawValue;
            }
        });

        // 检查必填字段
        if (!values.plotDescription) {
            warnings.push(`第 ${rowIndex + 2} 行缺少画面描述`);
        }

        return createStoryboardRow(values.shotNumber || rowIndex + 1, {
            ...(values as Partial<StoryboardRow>),
            shotNumber: values.shotNumber || rowIndex + 1,
            status: "idle",
        });
    });

    if (!hasPlotDescription) {
        warnings.push("未识别到「画面描述」列，请检查表头或下载模板参考标准格式");
    }

    if (unmappedHeaders.length) {
        warnings.push(`未识别的列：${unmappedHeaders.join("、")}（将被忽略）`);
    }

    return {
        rawRows: rawRows.map((row) => row.map((cell) => String(cell || ""))),
        headers,
        mapping,
        unmappedHeaders,
        rows,
        warnings,
        hasPlotDescription,
    };
}

/**
 * 根据用户手动修正的映射重新生成分镜行
 */
export function applyMapping(
    rawRows: string[][],
    mapping: ExcelImportMapping,
): StoryboardRow[] {
    const dataRows = rawRows.slice(1).filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
    return dataRows.map((rawRow, rowIndex) => {
        const values: Partial<StoryboardRow> = {};
        Object.entries(mapping).forEach(([colIndex, field]) => {
            if (!field) return;
            const rawValue = String(rawRow[Number(colIndex)] || "").trim();
            if (field === "durationSeconds") {
                const num = Number(rawValue);
                values.durationSeconds = isNaN(num) ? 6 : Math.min(60, Math.max(1, Math.round(num)));
            } else if (field === "shotNumber") {
                const num = Number(rawValue);
                values.shotNumber = isNaN(num) ? rowIndex + 1 : Math.round(num);
            } else {
                (values as Record<string, string>)[field] = rawValue;
            }
        });

        return createStoryboardRow(values.shotNumber || rowIndex + 1, {
            ...(values as Partial<StoryboardRow>),
            shotNumber: values.shotNumber || rowIndex + 1,
            status: "idle",
        });
    });
}

/**
 * 触发文件选择器，返回用户选择的 Excel 文件
 */
export function pickExcelFile(): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".xlsx,.xls,.csv";
        input.style.position = "fixed";
        input.style.left = "-9999px";
        input.style.opacity = "0";
        document.body.appendChild(input);

        let resolved = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            if (input.parentNode) document.body.removeChild(input);
        };
        const done = (value: File | null) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve(value);
        };

        input.addEventListener("change", () => done(input.files?.[0] || null), { once: true });
        input.addEventListener("cancel", () => done(null), { once: true });

        // 兜底：30 秒后自动清理，防止悬挂
        timeout = setTimeout(() => done(null), 30000);

        input.click();
    });
}

/**
 * 下载分镜脚本 Excel 模板
 */
export function downloadStoryboardTemplate(): void {
    const headers = IMPORTABLE_FIELDS.map((field) => IMPORTABLE_FIELD_LABELS[field]);
    // 添加两行示例数据
    const exampleData = [
        headers,
        [1, 5, "远景：城市天际线，清晨阳光洒落", "旁白：这是一个关于希望的故事", "", "", "", "远景", "温暖", "晨光", "", "固定机位", "", "", "", "", "", ""],
        [2, 3, "特写：主角面部表情，眼神坚定", "主角：我一定能做到", "", "", "", "特写", "坚定", "侧光", "", "推镜头", "", "", "", "", "", ""],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(exampleData);
    // 设置列宽
    worksheet["!cols"] = IMPORTABLE_FIELDS.map((field) => ({
        wch: field === "plotDescription" || field === "imageGenerationPrompt" || field === "videoMotionPrompt" ? 40 : field === "dialogue" ? 30 : 15,
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "分镜脚本模板");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    saveAs(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "分镜脚本模板.xlsx");
}

/**
 * 将分镜脚本数据导出为 Excel 文件并下载
 */
export function exportStoryboardExcel(rows: StoryboardRow[], title?: string): void {
    if (!rows.length) return;

    // 表头行：使用中文标签
    const headers = IMPORTABLE_FIELDS.map((field) => IMPORTABLE_FIELD_LABELS[field]);

    // 数据行：按 IMPORTABLE_FIELDS 顺序提取每个字段的值
    const dataRows = rows.map((row) =>
        IMPORTABLE_FIELDS.map((field) => {
            const value = row[field];
            if (field === "shotNumber" || field === "durationSeconds") {
                return Number(value) || (field === "durationSeconds" ? 6 : 0);
            }
            return String(value || "");
        }),
    );

    const allData = [headers, ...dataRows];
    const worksheet = XLSX.utils.aoa_to_sheet(allData);

    // 设置列宽
    worksheet["!cols"] = IMPORTABLE_FIELDS.map((field) => ({
        wch: field === "plotDescription" || field === "imageGenerationPrompt" || field === "videoMotionPrompt" ? 40 : field === "dialogue" ? 30 : 15,
    }));

    const workbook = XLSX.utils.book_new();
    const sheetName = "分镜脚本";
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    const fileName = title ? `${title}.xlsx` : `分镜脚本_${new Date().toLocaleDateString("zh-CN").replace(/\//g, "-")}.xlsx`;
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    saveAs(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileName);
}
