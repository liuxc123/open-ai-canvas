import localforage from "localforage";

import { IMAGE_MICRO_LONG_EDGE, IMAGE_THUMB_LONG_EDGE, shouldGenerateImageThumb } from "@/lib/canvas/canvas-image-lod";
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
/** 常驻内存的缩略图 object URL 上限：超出后按 LRU 逐出未被持有的 URL（revoke 释放 blob），避免大画布内存无限增长。 */
const MAX_THUMB_URLS = 512;

const thumbStore = localforage.createInstance({ name: "infinite-canvas", storeName: "resource_thumbs" });
const thumbUrls = new Map<string, string>();
const thumbUrlLeases = new Map<string, number>();
const runningKeys = new Set<string>();
const queue: GenerationJob[] = [];
let activeGenerations = 0;

export function canvasImageThumbSupported(): boolean {
    return typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

function thumbKey(userScope: string, resourceId: string, longEdge: number) {
    return `${userScope}:${resourceId}:t${longEdge}`;
}

/**
 * 获取某个画布图片素材的低分辨率 object URL。
 * @param options.longEdge 目标长边档位（768 缩略图 / 192 micro 档），默认 768。
 * - 命中内存 / IDB 缓存时同步返回（毫秒级）；
 * - 未生成过且原图已缓存时，入队后台生成，本次返回 ""（调用方回退原图）；
 * - 原图未缓存或环境不支持时返回 ""。
 */
export async function getImageThumbObjectUrl(storageKey: string, options?: { priority?: number; longEdge?: number }): Promise<string> {
    if (!canvasImageThumbSupported()) return "";
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return "";
    const userScope = getActiveUserScope();
    if (!userScope) return "";
    const longEdge = options?.longEdge === IMAGE_MICRO_LONG_EDGE ? IMAGE_MICRO_LONG_EDGE : IMAGE_THUMB_LONG_EDGE;
    const key = thumbKey(userScope, resourceId, longEdge);

    const memoUrl = thumbUrls.get(key);
    if (memoUrl) {
        refreshThumbUrlRecency(key, memoUrl);
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
    if (source && sourceVersion) enqueueGeneration(key, source, sourceVersion, options?.priority ?? 1, longEdge);
    return url;
}

/** 清空缓存（调试 / 存储压力场景使用）。 */
export async function clearImageThumbCache(): Promise<void> {
    queue.length = 0;
    runningKeys.clear();
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    thumbUrls.clear();
    thumbUrlLeases.clear();
    await thumbStore.clear().catch(() => undefined);
}

function enqueueGeneration(key: string, source: Blob, sourceVersion: string, priority: number, longEdge: number) {
    if (runningKeys.has(key)) return;
    const existing = queue.find((job) => job.key === key);
    if (existing) {
        // 已在队列中：更新为更高优先级（更小值），使可见节点更早生成。
        if (priority < existing.priority) {
            existing.priority = priority;
            queue.sort((a, b) => a.priority - b.priority);
            pumpQueue();
        }
        return;
    }
    queue.push({
        key,
        priority,
        run: async () => {
            const thumbBlob = await encodeImageThumb(source, longEdge).catch(() => null);
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

async function encodeImageThumb(source: Blob, longEdge: number): Promise<Blob | null> {
    if (!shouldGenerateImageThumb(source.type, 0, 0)) return null;
    const bitmap = await createImageBitmap(source).catch(() => null);
    if (!bitmap) return null;
    try {
        // 解码后用真实尺寸再判定一次（小图 / 异常数据直接放弃）。
        if (!shouldGenerateImageThumb(source.type, bitmap.width, bitmap.height)) return null;
        const ratio = longEdge / Math.max(bitmap.width, bitmap.height);
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
        thumbUrlLeases.delete(existing);
    }
    const url = URL.createObjectURL(blob);
    thumbUrls.set(key, url);
    pruneThumbUrls();
    return url;
}

/** 命中内存缓存时刷新 LRU 顺序（Map 插入序即最近使用序）。 */
function refreshThumbUrlRecency(key: string, url: string) {
    if (thumbUrls.get(key) !== url) return;
    thumbUrls.delete(key);
    thumbUrls.set(key, url);
}

/**
 * 声明某个缩略图 URL 正被展示（如画布节点 <img> 挂载中）。被持有的 URL 不会被 LRU 逐出，
 * 避免 revoke 掉正在显示的地址。与 releaseImageThumbUrl 成对调用。
 */
export function retainImageThumbUrl(url: string) {
    if (!url) return;
    thumbUrlLeases.set(url, (thumbUrlLeases.get(url) || 0) + 1);
}

/** 释放缩略图 URL 的持有（节点卸载 / 切换到其他地址时调用）。 */
export function releaseImageThumbUrl(url: string) {
    if (!url) return;
    const count = thumbUrlLeases.get(url);
    if (!count) return;
    if (count <= 1) thumbUrlLeases.delete(url);
    else thumbUrlLeases.set(url, count - 1);
    pruneThumbUrls();
}

/**
 * LRU 逐出：object URL 数量超过上限时，从最久未使用的开始 revoke（释放 blob 内存）。
 * 正被持有（retained）的 URL 跳过；全部被持有时放弃本轮逐出，等待下次释放。
 */
function pruneThumbUrls() {
    if (thumbUrls.size <= MAX_THUMB_URLS) return;
    for (const [key, url] of thumbUrls) {
        if (thumbUrls.size <= MAX_THUMB_URLS) break;
        if (thumbUrlLeases.has(url)) continue;
        URL.revokeObjectURL(url);
        thumbUrls.delete(key);
    }
}

async function touchThumb(key: string) {
    const record = await thumbStore.getItem<ThumbRecord>(key);
    if (!record || Date.now() - record.lastAccessedAt < TOUCH_INTERVAL_MS) return;
    await thumbStore.setItem(key, { ...record, lastAccessedAt: Date.now() });
}

/**
 * touchThumb 的延迟合并版本：把多次访问合并为一次 setTimeout(0) 后的 IDB 写入，避免拖拽等高频
 * 渲染路径上每帧都触发 getItem+setItem 的微任务排队。
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
