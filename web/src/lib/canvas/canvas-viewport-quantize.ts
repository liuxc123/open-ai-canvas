// 画布视口量化（纯逻辑，可单测）：
// 1) quantizeViewportScale：把传给节点的 scale 按固定步长取整，避免缩放期间每帧都让
//    React.memo 失效导致全部可见节点重渲染；
// 2) quantizeViewportForCulling：把参与可见性裁剪（visibleNodes）的视口平移/缩放按
//    粗粒度网格量化，平移/缩放进行中只有跨过网格边界才重算可见集，形成视口迟滞。

/** scale 量化步长（1/32 ≈ 3.1%），同一档内缩放不触发节点重渲染。 */
export const VIEWPORT_SCALE_QUANT_STEP = 1 / 32;

/** scale 最小值，与画布视口的最小缩放保持一致。 */
export const VIEWPORT_SCALE_MIN = 0.05;

/** 裁剪视口平移量化步长（屏幕像素）。必须 ≤ 裁剪 padding 的最小值（性能模式 240px），保证量化误差被 padding 覆盖。 */
export const CULL_MOVE_STEP_PX = 192;

/** 裁剪视口缩放量化步长（对数刻度，每档 6.25%）。 */
export const CULL_ZOOM_STEP_RATIO = 1.0625;

/** 量化传给节点的 scale：四舍五入到固定网格，档内变化不再逐帧下传。 */
export function quantizeViewportScale(k: number): number {
    if (!Number.isFinite(k) || k <= 0) return 1;
    const clamped = Math.max(VIEWPORT_SCALE_MIN, k);
    return Math.max(VIEWPORT_SCALE_MIN, Math.round(clamped / VIEWPORT_SCALE_QUANT_STEP) * VIEWPORT_SCALE_QUANT_STEP);
}

/**
 * 量化参与裁剪计算的视口。
 * - 平移向下取整到 CULL_MOVE_STEP_PX 网格：视口左上角最多向左/上偏移一个步长，
 *   裁剪矩形整体随之偏移，误差（≤ 192px）被裁剪 padding（≥ 240px）吸收；
 * - 缩放在对数刻度向下取整：量化 k 恒 ≤ 真实 k，换算出的世界坐标裁剪矩形恒 ≥ 真实视口范围，
 *   不会把可见节点误裁掉，只会多渲染一点边缘内容。
 */
export function quantizeViewportForCulling(viewport: { x: number; y: number; k: number }): { x: number; y: number; k: number } {
    const k = Number.isFinite(viewport.k) && viewport.k > 0 ? viewport.k : 1;
    const clampedK = Math.max(VIEWPORT_SCALE_MIN, k);
    const quantizedK = Math.max(VIEWPORT_SCALE_MIN, CULL_ZOOM_STEP_RATIO ** Math.floor(Math.log(clampedK) / Math.log(CULL_ZOOM_STEP_RATIO)));
    return {
        x: Math.floor(viewport.x / CULL_MOVE_STEP_PX) * CULL_MOVE_STEP_PX,
        y: Math.floor(viewport.y / CULL_MOVE_STEP_PX) * CULL_MOVE_STEP_PX,
        k: quantizedK,
    };
}
