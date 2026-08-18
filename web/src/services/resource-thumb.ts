// 图片缩略图服务：为已缓存到本地的远程图片生成低分辨率档位（默认 768 长边 WebP），
// 供画布节点在缩放较小时使用，降低解码与 GPU 纹理内存开销。
//
// 设计要点：
// - 纯本地派生数据：不触网、不改后端、不影响素材同步协议；
// - key 按用户 + 资源 ID 维度存储，记录源 blob 的 size 作为版本指纹，原图更新后自动失效重建；
// - 原图未缓存（可能要触发下载）时直接放弃生成，回退展示原图，避免为了缩略图反而下载原图；
// - 生成走并发受控的优先级队列（可见节点优先），编码基于 OffscreenCanvas 异步 API，不阻塞交互。

import localforage from "localforage";

import { IMAGE_THUMB_LONG_EDGE, shouldGenerateImageThumb } from "@/lib/canvas/canvas-image-lod";
import { getActiveUserScope } from "@/lib/user-scope";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { peekCachedResourceBlob } from "@/services/resource-blob-cache";

type ThumbRecord = {
    sourceVersion: string;
    mimeType: string;
    bytes: number;
    lastAccessedAt: number;
    blob: Blob;
};

type GenerationJob = {
    key: string;
    priority: number;
    run: () => Promise<void>;
};

const MAX_THUMB_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_CONCURRENT_GENERATIONS = 2;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

const thumbStore = localforage.createInstance({ name: "infinite-canvas", storeName: "resource_thumbs" });
const thumbUrls = new Map<string, string>();
const runningKeys = new Set<string>();
const queue: GenerationJob[] = [];
let activeGenerations = 0;

export function canvasImageThumbSupported(): boolean {
    return typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

function thumbKey(userScope: string, resourceId: string) {
    return `${userScope}:${resourceId}:t${IMAGE_THUMB_LONG_EDGE}`;
}

/**
 * 获取某个画布图片素材的缩略图 object URL。
 * - 命中内存 / IDB 缓存时同步返回（毫秒级）；
 * - 未生成过且原图已缓存时，入队后台生成，本次返回 ""（调用方回退原图）；
 * - 原图未缓存或环境不支持时返回 ""。
 */
export async function getImageThumbObjectUrl(storageKey: string, options?: { priority?: number }): Promise<string> {
    if (!canvasImageThumbSupported()) return "";
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return "";
    const userScope = getActiveUserScope();
    if (!userScope) return "";
    const key = thumbKey(userScope, resourceId);

    const memoUrl = thumbUrls.get(key);
    if (memoUrl) {
        scheduleTouchThumb(key);
        return memoUrl;
    }

    const [record, source] = await Promise.all([thumbStore.getItem<ThumbRecord>(key).catch(() => null), peekCachedResourceBlob(storageKey).catch(() => null)]);
    const sourceVersion = source ? `${source.size}` : "";
    let url = "";
    if (record?.blob) {
        url = ensureThumbUrl(key, record.blob);
        if (!sourceVersion || record.sourceVersion === sourceVersion) {
            scheduleTouchThumb(key);
            if (sourceVersion) return url;
        }
    }
    if (source && sourceVersion) enqueueGeneration(key, source, sourceVersion, options?.priority ?? 1);
    return url;
}

/** 清空缩略图缓存（调试 / 存储压力场景使用）。 */
export async function clearImageThumbCache(): Promise<void> {
    queue.length = 0;
    runningKeys.clear();
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    thumbUrls.clear();
    await thumbStore.clear().catch(() => undefined);
}

function enqueueGeneration(key: string, source: Blob, sourceVersion: string, priority: number) {
    if (runningKeys.has(key)) return;
    queue.push({
        key,
        priority,
        run: async () => {
            const thumbBlob = await encodeImageThumb(source).catch(() => null);
            if (!thumbBlob) return;
            const record: ThumbRecord = {
                sourceVersion,
                mimeType: thumbBlob.type,
                bytes: thumbBlob.size,
                lastAccessedAt: Date.now(),
                blob: thumbBlob,
            };
            await evictThumbsFor(record.bytes);
            await thumbStore.setItem(key, record).catch(() => undefined);
            ensureThumbUrl(key, thumbBlob);
        },
    });
    queue.sort((a, b) => a.priority - b.priority);
    pumpQueue();
}

function pumpQueue() {
    while (activeGenerations < MAX_CONCURRENT_GENERATIONS && queue.length) {
        const job = queue.shift();
        if (!job || runningKeys.has(job.key)) continue;
        runningKeys.add(job.key);
        activeGenerations += 1;
        void job
            .run()
            .catch(() => undefined)
            .finally(() => {
                runningKeys.delete(job.key);
                activeGenerations -= 1;
                pumpQueue();
            });
    }
}

async function encodeImageThumb(source: Blob): Promise<Blob | null> {
    if (!shouldGenerateImageThumb(source.type, 0, 0)) return null;
    const bitmap = await createImageBitmap(source).catch(() => null);
    if (!bitmap) return null;
    try {
        // 解码后用真实尺寸再判定一次（小图 / 异常数据直接放弃）。
        if (!shouldGenerateImageThumb(source.type, bitmap.width, bitmap.height)) return null;
        const ratio = IMAGE_THUMB_LONG_EDGE / Math.max(bitmap.width, bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * ratio));
        const height = Math.max(1, Math.round(bitmap.height * ratio));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, width, height);
        const type = (await offscreenWebpSupported()) ? "image/webp" : "image/jpeg";
        const blob = await canvas.convertToBlob({ type, quality: 0.8 }).catch(() => null);
        return blob && blob.size > 0 ? blob : null;
    } finally {
        bitmap.close();
    }
}

let webpSupportPromise: Promise<boolean> | null = null;
function offscreenWebpSupported(): Promise<boolean> {
    if (!webpSupportPromise) {
        webpSupportPromise = new OffscreenCanvas(2, 2)
            .convertToBlob({ type: "image/webp" })
            .then((blob) => blob?.type === "image/webp")
            .catch(() => false);
    }
    return webpSupportPromise;
}

function ensureThumbUrl(key: string, blob: Blob): string {
    const existing = thumbUrls.get(key);
    if (existing) {
        URL.revokeObjectURL(existing);
        thumbUrls.delete(key);
    }
    const url = URL.createObjectURL(blob);
    thumbUrls.set(key, url);
    return url;
}

async function touchThumb(key: string) {
    const record = await thumbStore.getItem<ThumbRecord>(key);
    if (!record || Date.now() - record.lastAccessedAt < TOUCH_INTERVAL_MS) return;
    await thumbStore.setItem(key, { ...record, lastAccessedAt: Date.now() });
}

/**
 * touchThumb 的延迟合并版本：把多次访问合并为一次空闲时的 IDB 写入，避免拖拽等高频渲染路径上
 * 每帧都触发 getItem+setItem 的微任务排队。用 requestIdleCallback 退化到 setTimeout(0) 兜底。
 */
let touchTimer: ReturnType<typeof setTimeout> | null = null;
const pendingTouchKeys = new Set<string>();
function scheduleTouchThumb(key: string) {
    pendingTouchKeys.add(key);
    if (touchTimer !== null) return;
    touchTimer = setTimeout(() => {
        touchTimer = null;
        const keys = pendingTouchKeys;
        pendingTouchKeys.clear();
        for (const k of keys) void touchThumb(k).catch(() => undefined);
    }, 0);
}

async function evictThumbsFor(incomingBytes: number) {
    const records: Array<{ key: string; bytes: number; lastAccessedAt: number }> = [];
    await thumbStore.iterate<ThumbRecord, void>((record, key) => {
        if (record) records.push({ key, bytes: record.bytes || record.blob?.size || 0, lastAccessedAt: record.lastAccessedAt || 0 });
    });
    let total = records.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
    if (total + incomingBytes <= MAX_THUMB_CACHE_BYTES) return;
    records.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (const candidate of records) {
        if (total + incomingBytes <= MAX_THUMB_CACHE_BYTES) break;
        const url = thumbUrls.get(candidate.key);
        if (url) URL.revokeObjectURL(url);
        thumbUrls.delete(candidate.key);
        await thumbStore.removeItem(candidate.key).catch(() => undefined);
        total -= candidate.bytes;
    }
}
