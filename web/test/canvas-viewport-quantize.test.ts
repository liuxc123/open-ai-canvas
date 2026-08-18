import { describe, expect, test } from "bun:test";

import { CULL_MOVE_STEP_PX, CULL_ZOOM_STEP_RATIO, VIEWPORT_SCALE_QUANT_STEP, quantizeViewportForCulling, quantizeViewportScale } from "@/lib/canvas/canvas-viewport-quantize";

describe("quantizeViewportScale", () => {
    test("档内的微小变化量化为同一值", () => {
        const base = quantizeViewportScale(1);
        expect(quantizeViewportScale(1 + VIEWPORT_SCALE_QUANT_STEP * 0.4)).toBe(base);
        expect(quantizeViewportScale(1 - VIEWPORT_SCALE_QUANT_STEP * 0.4)).toBe(base);
    });

    test("跨过半个步长才进位", () => {
        expect(quantizeViewportScale(1 + VIEWPORT_SCALE_QUANT_STEP * 0.6)).toBeGreaterThan(quantizeViewportScale(1));
    });

    test("非法值与极小值兜底", () => {
        expect(quantizeViewportScale(0)).toBe(1);
        expect(quantizeViewportScale(Number.NaN)).toBe(1);
        expect(quantizeViewportScale(-1)).toBe(1);
        expect(quantizeViewportScale(0.001)).toBeGreaterThanOrEqual(0.05);
    });
});

describe("quantizeViewportForCulling", () => {
    test("平移在步长网格内量化结果不变，跨过网格才前进一格", () => {
        const base = quantizeViewportForCulling({ x: 0, y: 0, k: 1 });
        const withinCell = quantizeViewportForCulling({ x: CULL_MOVE_STEP_PX - 1, y: CULL_MOVE_STEP_PX - 1, k: 1 });
        expect(withinCell).toEqual(base);
        const nextCell = quantizeViewportForCulling({ x: CULL_MOVE_STEP_PX + 1, y: 0, k: 1 });
        expect(nextCell.x).toBe(CULL_MOVE_STEP_PX);
    });

    test("缩放量化结果恒不大于真实 k（裁剪矩形只会更大，不会误裁）", () => {
        for (const k of [0.06, 0.25, 0.5, 0.9, 1, 1.37, 2.5, 8]) {
            const quantized = quantizeViewportForCulling({ x: 0, y: 0, k });
            expect(quantized.k).toBeLessThanOrEqual(k);
            expect(quantized.k).toBeGreaterThanOrEqual(k / CULL_ZOOM_STEP_RATIO);
            expect(quantized.k).toBeGreaterThanOrEqual(0.05);
        }
    });

    test("缩放在档内变化时量化结果不变", () => {
        const base = quantizeViewportForCulling({ x: 0, y: 0, k: 1 });
        const withinStep = quantizeViewportForCulling({ x: 0, y: 0, k: 1 * (CULL_ZOOM_STEP_RATIO - 0.001) });
        expect(withinStep.k).toBe(base.k);
    });

    test("负坐标 floor 到正确网格（向 -∞ 取整）", () => {
        const quantized = quantizeViewportForCulling({ x: -1, y: 0, k: 1 });
        expect(quantized.x).toBe(-CULL_MOVE_STEP_PX);
    });

    test("非法 k 兜底为 1", () => {
        expect(quantizeViewportForCulling({ x: 0, y: 0, k: Number.NaN }).k).toBe(1);
    });
});
