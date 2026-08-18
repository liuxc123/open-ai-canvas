import { useEffect, useRef, useState } from "react";

import { resourceIdFromStorageKey } from "@/services/api/resources";
import { getImageThumbObjectUrl } from "@/services/resource-thumb";

/**
 * 小尺寸图片展示场景的统一缩略图地址解析：素材已缓存到本地且支持缩略图时返回缩略图 object URL，
 * 否则返回调用方给定的回退地址（原图 dataURL / 远程 URL 均可）。不会为了缩略图触发下载原图；
 * 缩略图在后台生成完成后自动完成切换。
 *
 * 渲染路径开销控制：用 ref 缓存已解析的 url，同一 storageKey + fallbackUrl 组合在重渲染时
 * 直接返回缓存值，不再每帧触发 async IDB 查询；仅当 storageKey 或 fallbackUrl 实际变化时才重新解析。
 */
export function useImageThumbUrl(storageKey: string | undefined, fallbackUrl: string, options?: { priority?: number }) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    const priority = options?.priority ?? 2;
    const cacheRef = useRef<{ storageKey: string | undefined; fallbackUrl: string; url: string }>({ storageKey: undefined, fallbackUrl: "", url: "" });
    const [thumbUrl, setThumbUrl] = useState(() => (cacheRef.current.storageKey === storageKey && cacheRef.current.fallbackUrl === fallbackUrl ? cacheRef.current.url : ""));
    useEffect(() => {
        if (!resourceId || !fallbackUrl) {
            cacheRef.current = { storageKey, fallbackUrl, url: "" };
            setThumbUrl("");
            return;
        }
        // 同一组合已解析过且当前仍在使用同一 fallbackUrl，直接复用缓存，跳过 async 查询。
        if (cacheRef.current.storageKey === storageKey && cacheRef.current.fallbackUrl === fallbackUrl && cacheRef.current.url) {
            setThumbUrl(cacheRef.current.url);
            return;
        }
        let cancelled = false;
        void getImageThumbObjectUrl(storageKey!, { priority })
            .then((url) => {
                if (cancelled) return;
                cacheRef.current = { storageKey, fallbackUrl, url };
                setThumbUrl(url);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [fallbackUrl, priority, resourceId, storageKey]);
    return thumbUrl || fallbackUrl;
}
