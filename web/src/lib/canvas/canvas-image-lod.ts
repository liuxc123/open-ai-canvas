// 画布图片节点的缩略图 LOD（Level of Detail）纯逻辑：
// 仅包含可单测的判定函数，IO 与存储在 services/resource-thumb.ts 中实现。

/** 缩略图长边档位（WebP/JPEG 编码后的目标长边）。 */
export const IMAGE_THUMB_LONG_EDGE = 768;

/** 原图长边不超过该值时不生成缩略图（缩了没有收益）。 */
export const IMAGE_THUMB_GENERATE_MIN_SOURCE_EDGE = 1024;

/** 缩略图 -> 原图 的升档阈值（屏幕像素）。 */
export const IMAGE_THUMB_FULL_UPGRADE_PX = IMAGE_THUMB_LONG_EDGE;

/** 原图 -> 缩略图 的降档阈值（屏幕像素），与升档阈值之间形成迟滞区间，避免缩放时反复切档。 */
export const IMAGE_THUMB_FULL_DOWNGRADE_PX = 480;

/**
 * 计算图片节点在屏幕上实际需要的分辨率（长边，屏幕像素）。
 * object-contain 下图片显示长边不会超过节点盒子的短边，因此取 min(width, height) 作为保守上界，
 * 再乘视口缩放与设备像素比，留 1.2 的安全余量覆盖插值损失。
 */
export function imageNodeDisplayLongEdge(nodeWidth: number, nodeHeight: number, viewportScale: number, devicePixelRatio = 1): number {
    const ratio = Math.min(3, Math.max(1, devicePixelRatio || 1));
    const boxEdge = Math.min(Math.max(nodeWidth, 1), Math.max(nodeHeight, 1));
    return Math.ceil(boxEdge * Math.max(viewportScale, 0.05) * ratio * 1.2);
}

/**
 * 迟滞切档判定：当前档位为缩略图时超过升档阈值才换原图；当前为原图时降到降档阈值以下才回缩略图。
 * @param displayLongEdgePx imageNodeDisplayLongEdge 的计算结果
 * @param currentFull 当前是否已使用原图
 */
export function imageNodeWantsFullResolution(displayLongEdgePx: number, currentFull: boolean): boolean {
    if (currentFull) return displayLongEdgePx > IMAGE_THUMB_FULL_DOWNGRADE_PX;
    return displayLongEdgePx > IMAGE_THUMB_FULL_UPGRADE_PX;
}

/**
 * 是否需要为某个素材生成缩略图。GIF（动图重编码会丢动画）与本身就足够小的图跳过。
 * 解码前尺寸未知时传 0（返回 true，解码后可用真实尺寸再判定一次）。
 */
export function shouldGenerateImageThumb(mimeType: string | undefined, width: number, height: number): boolean {
    if ((mimeType || "").toLowerCase() === "image/gif") return false;
    const longEdge = Math.max(width, height);
    if (longEdge > 0 && longEdge <= IMAGE_THUMB_GENERATE_MIN_SOURCE_EDGE) return false;
    return true;
}
