import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { normalizeVideoDuration, VIDEO_DURATION_OPTIONS } from "@/lib/video-generation-options";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const SEEDANCE_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};

export const seedanceResolutionOptions = [
    { value: "480p", label: "480P" },
    { value: "720p", label: "720P" },
    { value: "1080p", label: "1080P" },
] as const;

export const seedanceRatioOptions = [
    { value: "16:9", label: "横屏" },
    { value: "9:16", label: "竖屏" },
    { value: "1:1", label: "方形" },
    { value: "4:3", label: "标准横屏" },
    { value: "3:4", label: "标准竖屏" },
    { value: "21:9", label: "宽银幕" },
    { value: "adaptive", label: "自适应" },
] as const;

export const seedanceDurationOptions = VIDEO_DURATION_OPTIONS;

const seedancePixels = {
    "480p": {
        "16:9": "864x496",
        "4:3": "752x560",
        "1:1": "640x640",
        "3:4": "560x752",
        "9:16": "496x864",
        "21:9": "992x432",
    },
    "720p": {
        "16:9": "1280x720",
        "4:3": "1112x834",
        "1:1": "960x960",
        "3:4": "834x1112",
        "9:16": "720x1280",
        "21:9": "1470x630",
    },
    "1080p": {
        "16:9": "1920x1080",
        "4:3": "1664x1248",
        "1:1": "1440x1440",
        "3:4": "1248x1664",
        "9:16": "1080x1920",
        "21:9": "2206x946",
    },
} as const;

export function isSeedanceVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isSeedanceVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel)) || isArkPlanBaseUrl(requestConfig.baseUrl);
}

export function isSeedanceVideoModel(model: string) {
    const value = model.toLowerCase();
    return value.includes("seedance") || value.includes("doubao-seedance");
}

export function isSeedanceFastModel(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && value.includes("fast");
}

export function isArkPlanBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("ark.cn-beijing.volces.com/api/plan/v3") || baseUrl.toLowerCase().includes("/api/plan/v3");
}

export function normalizeSeedanceResolution(value: string, model = "") {
    const normalized = normalizeResolutionToken(value);
    if (isSeedanceFastModel(model) && (normalized === "1080p" || normalized === "2160p")) return "720p";
    return normalized === "2160p" || seedanceResolutionOptions.some((item) => item.value === normalized) ? normalized : "720p";
}

export function normalizeResolutionToken(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    if (value.toLowerCase() === "4k") return "2160p";
    const resolution = String(value || "").replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function normalizeSeedanceDuration(value: string) {
    return Number(normalizeVideoDuration(value));
}

export function normalizeSeedanceRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    if (seedanceRatioOptions.some((item) => item.value === value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "adaptive";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "adaptive";
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["4:3", 4 / 3],
        ["1:1", 1],
        ["3:4", 3 / 4],
        ["9:16", 9 / 16],
        ["21:9", 21 / 9],
    ] as const;
    return options.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), options[0])[0];
}

export function seedancePixelLabel(resolution: string, ratio: string) {
    const normalizedResolution = normalizeSeedanceResolution(resolution) as keyof typeof seedancePixels;
    const normalizedRatio = normalizeSeedanceRatio(ratio) as keyof (typeof seedancePixels)[typeof normalizedResolution] | "adaptive";
    if (normalizedRatio === "adaptive") return "自动匹配";
    return seedancePixels[normalizedResolution][normalizedRatio] || "";
}

export function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export function seedanceReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    if (kind === "image") return `图片${index + 1}`;
    if (kind === "video") return `视频${index + 1}`;
    return `音频${index + 1}`;
}

export function buildSeedancePromptText(prompt: string, _images: ReferenceImage[], _videos: ReferenceVideo[], _audios: ReferenceAudio[]) {
    return prompt.trim();
}

export function seedanceVideoReferenceError(videos: ReferenceVideo[]) {
    let totalDurationMs = 0;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = seedanceReferenceLabel("video", index);
        if (video.bytes && video.bytes > SEEDANCE_REFERENCE_LIMITS.videoMaxBytes) return `${label} 超过 50MB，请压缩后再上传`;
        if (video.durationMs) {
            if (video.durationMs < 2000 || video.durationMs > 15000) return `${label} 时长需要在 2-15 秒之间`;
            totalDurationMs += video.durationMs;
        }
        if (video.width && video.height) {
            if (video.width < 300 || video.width > 6000 || video.height < 300 || video.height > 6000) return `${label} 宽高需要在 300-6000px 之间`;
            const ratio = video.width / video.height;
            if (ratio < 0.4 || ratio > 2.5) return `${label} 宽高比需要在 0.4-2.5 之间`;
            const pixels = video.width * video.height;
            if (pixels < 640 * 640 || pixels > 2206 * 946) return `${label} 像素总量不符合 Seedance 要求，请转成 480p/720p/1080p 后再上传`;
        }
    }
    if (totalDurationMs > 15000) return "Seedance 参考视频总时长不能超过 15 秒";
    return "";
}

export const seedanceVideoReferenceHint = "参考视频需为 mp4/mov，H.264/H.265，FPS 24-60；含真人人脸素材请使用火山授权 asset:// 素材。";

// ===== Seedance 资产预注册 =====

/**
 * 在前端直接调用 Seedance API 前，确保所有参考素材已注册并通过审核。
 * 注册流程：POST /api/seedance/assets/register-batch -> 轮询 GET /api/seedance/assets
 * 注册成功后，将素材 URL 替换为 asset://upstreamAssetId。
 */
export async function ensureSeedanceAssetsRegistered(
    config: AiConfig,
    references: ReferenceImage[],
    videoReferences: ReferenceVideo[],
    audioReferences: ReferenceAudio[],
): Promise<{ references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[] }> {
    const requestConfig = resolveModelRequestConfig(config, (config.model || config.videoModel).trim());
    if (!isSeedanceVideoConfig(requestConfig) || requestConfig.channelId === "") {
        return { references, videoReferences, audioReferences };
    }

    // 收集所有需要注册的素材 resourceId
    const allMedia: Array<{ kind: "image" | "video" | "audio"; resourceId: string; ref: ReferenceImage | ReferenceVideo | ReferenceAudio }> = [];
    for (const img of references) {
        const id = extractResourceId(img.storageKey);
        if (id) allMedia.push({ kind: "image", resourceId: id, ref: img });
    }
    for (const vid of videoReferences) {
        const id = extractResourceId(vid.storageKey);
        if (id) allMedia.push({ kind: "video", resourceId: id, ref: vid });
    }
    for (const aud of audioReferences) {
        const id = extractResourceId(aud.storageKey);
        if (id) allMedia.push({ kind: "audio", resourceId: id, ref: aud });
    }

    if (allMedia.length === 0) return { references, videoReferences, audioReferences };

    const { apiClient, request } = await import("@/services/api/request");

    // 1. 批量注册
    const items = allMedia.map((m) => ({ resourceId: m.resourceId, channelId: requestConfig.channelId, model: requestConfig.model }));
    const registerResp = await request<{ results: Array<{ resourceId: string; asset?: { upstreamAssetId: string; status: string }; error?: string }> }>(
        apiClient.post("/seedance/assets/register-batch", { items }),
    );

    // 检查是否有注册失败的
    const failed = registerResp.results.filter((r) => r.error);
    if (failed.length > 0) {
        throw new Error(`素材注册失败：${failed.map((f) => f.resourceId).join(", ")}`);
    }

    // 2. 轮询等待所有素材终态
    const resourceIds = allMedia.map((m) => m.resourceId);
    const deadline = Date.now() + 5 * 60 * 1000; // 5 分钟超时
    const assetMap = new Map<string, { upstreamAssetId: string; status: string }>();

    for (const r of registerResp.results) {
        if (r.asset) assetMap.set(r.resourceId, { upstreamAssetId: r.asset.upstreamAssetId, status: r.asset.status });
    }

    while (Date.now() < deadline) {
        const pending = resourceIds.filter((id) => {
            const a = assetMap.get(id);
            return !a || a.status === "submitting" || a.status === "submitted" || a.status === "processing";
        });
        if (pending.length === 0) break;

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const assetsResp = await request<{ assets: Array<{ resourceId: string; upstreamAssetId: string; status: string }> }>(
            apiClient.get("/seedance/assets", { params: { channelId: requestConfig.channelId, resourceIds: resourceIds.join(",") } }),
        );
        for (const a of assetsResp.assets) {
            assetMap.set(a.resourceId, { upstreamAssetId: a.upstreamAssetId, status: a.status });
        }
    }

    // 3. 检查结果
    const failedAssets = resourceIds.filter((id) => {
        const a = assetMap.get(id);
        return !a || a.status !== "approved";
    });
    if (failedAssets.length > 0) {
        const failedNames = failedAssets.map((id) => {
            const m = allMedia.find((x) => x.resourceId === id);
            return (m?.ref as { title?: string })?.title || id;
        });
        throw new Error(`素材审核未通过：${failedNames.join(", ")}`);
    }

    // 4. 替换 URL 为 asset://upstreamAssetId
    const newReferences = references.map((img) => {
        const id = extractResourceId(img.storageKey);
        if (!id) return img;
        const a = assetMap.get(id);
        if (!a) return img;
        return { ...img, url: `asset://${a.upstreamAssetId}`, dataUrl: "" };
    });
    const newVideoReferences = videoReferences.map((vid) => {
        const id = extractResourceId(vid.storageKey);
        if (!id) return vid;
        const a = assetMap.get(id);
        if (!a) return vid;
        return { ...vid, url: `asset://${a.upstreamAssetId}` };
    });
    const newAudioReferences = audioReferences.map((aud) => {
        const id = extractResourceId(aud.storageKey);
        if (!id) return aud;
        const a = assetMap.get(id);
        if (!a) return aud;
        return { ...aud, url: `asset://${a.upstreamAssetId}` };
    });

    return { references: newReferences, videoReferences: newVideoReferences, audioReferences: newAudioReferences };
}

function extractResourceId(storageKey?: string): string | undefined {
    if (!storageKey || !storageKey.startsWith("resource:")) return undefined;
    return storageKey.replace("resource:", "");
}
