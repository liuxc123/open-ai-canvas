import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal, Select, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { applyMapping, downloadStoryboardTemplate, IMPORTABLE_FIELD_LABELS, type ExcelImportMapping, type ExcelImportResult, type ImportableField } from "@/lib/canvas/storyboard-excel-import";
import type { StoryboardRow } from "@/types/canvas";

const FIELD_OPTIONS: Array<{ label: string; value: ImportableField }> = Object.entries(IMPORTABLE_FIELD_LABELS).map(([value, label]) => ({
    label: `${label} (${value})`,
    value: value as ImportableField,
}));

type PreviewRow = Record<string, string>;

export function StoryboardExcelImportModal({
    open,
    importResult,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    importResult: ExcelImportResult | null;
    onCancel: () => void;
    onConfirm: (rows: StoryboardRow[], mode: "replace" | "append") => void;
}) {
    const [mapping, setMapping] = useState<ExcelImportMapping>({});
    const [mode, setMode] = useState<"replace" | "append">("replace");

    // 当导入结果变化时，同步初始映射
    useEffect(() => {
        if (importResult) {
            setMapping(importResult.mapping);
            setMode("replace");
        }
    }, [importResult]);

    // 根据当前映射生成预览行
    const previewRows = useMemo(() => {
        if (!importResult) return [];
        return applyMapping(importResult.rawRows, mapping).slice(0, 5);
    }, [importResult, mapping]);

    const unmappedHeaders = useMemo(() => {
        if (!importResult) return [];
        return Object.entries(mapping)
            .filter(([, field]) => !field)
            .map(([colIndex]) => importResult.headers[Number(colIndex)])
            .filter(Boolean);
    }, [importResult, mapping]);

    const mappedFieldCount = useMemo(
        () => Object.values(mapping).filter(Boolean).length,
        [mapping],
    );

    const handleMappingChange = useCallback((colIndex: number, field: ImportableField | null) => {
        setMapping((prev) => ({ ...prev, [colIndex]: field }));
    }, []);

    const handleConfirm = useCallback(() => {
        if (!importResult) return;
        const rows = applyMapping(importResult.rawRows, mapping);
        onConfirm(rows, mode);
    }, [importResult, mapping, mode, onConfirm]);

    if (!importResult) return null;

    // 预览表格列
    const previewColumns: ColumnsType<PreviewRow> = useMemo(() => {
        const cols: ColumnsType<PreviewRow> = [];
        importResult.headers.forEach((header, colIndex) => {
            const field = mapping[colIndex];
            if (!field) return;
            cols.push({
                title: IMPORTABLE_FIELD_LABELS[field],
                dataIndex: field,
                key: field,
                width: 160,
                ellipsis: true,
                render: (_: unknown, row: PreviewRow) => row[field] || <span className="text-foreground/30">—</span>,
            });
        });
        return cols;
    }, [importResult.headers, mapping]);

    // 预览数据转换为 Table 需要的格式
    const previewDataSource = useMemo<PreviewRow[]>(
        () => previewRows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v || "")]))) as PreviewRow[],
        [previewRows],
    );

    return (
        <Modal
            title="导入 Excel 分镜表"
            open={open}
            onCancel={onCancel}
            width="min(960px, calc(100vw - 40px))"
            centered
            destroyOnHidden
            footer={
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-foreground/50">导入方式：</span>
                        <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                            <input
                                type="radio"
                                checked={mode === "replace"}
                                onChange={() => setMode("replace")}
                                className="accent-[var(--ant-color-primary)]"
                            />
                            替换全部
                        </label>
                        <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                            <input
                                type="radio"
                                checked={mode === "append"}
                                onChange={() => setMode("append")}
                                className="accent-[var(--ant-color-primary)]"
                            />
                            追加到末尾
                        </label>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button icon={<Download className="size-3.5" />} onClick={downloadStoryboardTemplate}>
                            下载模板
                        </Button>
                        <Button onClick={onCancel}>取消</Button>
                        <Button type="primary" onClick={handleConfirm}>
                            确认导入（{importResult.rows.length} 个镜头）
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="mb-4 flex items-center gap-2">
                <FileSpreadsheet className="size-5 text-green-600" />
                <span className="text-sm font-medium">
                    已识别 {importResult.rows.length} 行数据 · {mappedFieldCount} 列已映射
                </span>
                {unmappedHeaders.length > 0 && (
                    <span className="text-xs text-foreground/50">
                        （{unmappedHeaders.length} 列将被忽略）
                    </span>
                )}
            </div>

            {importResult.warnings.length > 0 && (
                <Alert
                    className="mb-4"
                    type="warning"
                    showIcon
                    message="导入提示"
                    description={
                        <ul className="list-disc pl-4 text-xs space-y-0.5">
                            {importResult.warnings.slice(0, 8).map((w, i) => (
                                <li key={i}>{w}</li>
                            ))}
                            {importResult.warnings.length > 8 && (
                                <li>还有 {importResult.warnings.length - 8} 条警告...</li>
                            )}
                        </ul>
                    }
                />
            )}

            {/* 字段映射区域 */}
            <div className="mb-4">
                <div className="mb-2 text-sm font-semibold">字段映射</div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                    {importResult.headers.map((header, colIndex) => {
                        const field = mapping[colIndex];
                        return (
                            <div key={colIndex} className="flex items-center gap-2">
                                <Tag className="max-w-32 truncate" color={field ? "blue" : "default"}>
                                    {header || `列 ${colIndex + 1}`}
                                </Tag>
                                <span className="text-foreground/30">→</span>
                                <Select<ImportableField | null>
                                    size="small"
                                    className="min-w-40 flex-1"
                                    value={field || null}
                                    placeholder="忽略此列"
                                    options={FIELD_OPTIONS}
                                    allowClear
                                    onChange={(value) => handleMappingChange(colIndex, value || null)}
                                />
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 预览表格 */}
            {previewColumns.length > 0 && previewDataSource.length > 0 ? (
                <div>
                    <div className="mb-2 text-sm font-semibold">预览（前 5 行）</div>
                    <Table<PreviewRow>
                        rowKey={(_, index) => String(index)}
                        size="small"
                        bordered
                        pagination={false}
                        scroll={{ x: "max-content", y: 240 }}
                        dataSource={previewDataSource}
                        columns={previewColumns}
                    />
                </div>
            ) : (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <Upload className="size-8 text-foreground/30" />
                    <div className="text-sm text-foreground/50">
                        未识别到可映射的列，请检查 Excel 表头或<span className="text-primary cursor-pointer hover:underline" onClick={downloadStoryboardTemplate}>下载模板</span>参考标准格式
                    </div>
                </div>
            )}
        </Modal>
    );
}
