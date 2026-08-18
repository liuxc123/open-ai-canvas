import { describe, expect, test } from "bun:test";

import {
    IMAGE_MICRO_LONG_EDGE,
    IMAGE_MICRO_THUMB_DOWNGRADE_PX,
    IMAGE_MICRO_THUMB_UPGRADE_PX,
    IMAGE_THUMB_FULL_DOWNGRADE_PX,
    IMAGE_THUMB_FULL_UPGRADE_PX,
    IMAGE_THUMB_LONG_EDGE,
    imageNodeDetailTier,
    imageNodeDisplayLongEdge,
    imageNodeWantsFullResolution,
    shouldGenerateImageThumb,
    type ImageDetailTier,
} from "@/lib/canvas/canvas-image-lod";

describe("imageNodeDisplayLongEdge", () => {
    test("object-contain 下取节点盒子短边并乘缩放与 DPR", () => {
        // 320x240 节点，k=1，DPR=2：240 * 1 * 2 * 1.2 = 576
        expect(imageNodeDisplayLongEdge(320, 240, 1, 2)).toBe(576);
    });

    test("缩小视口下需求分辨率随 k 等比下降且钳制最小缩放", () => {
        expect(imageNodeDisplayLongEdge(400, 300, 0.5, 1)).toBe(180);
        // k 极小时按 0.05 钳制，避免需求分辨率算成 0
        expect(imageNodeDisplayLongEdge(400, 300, 0.001, 1)).toBe(Math.ceil(300 * 0.05 * 1.2));
    });

    test("DPR 超界时钳制到 [1,3]", () => {
        expect(imageNodeDisplayLongEdge(200, 100, 1, 0)).toBe(Math.ceil(100 * 1.2));
        expect(imageNodeDisplayLongEdge(200, 100, 1, 8)).toBe(Math.ceil(100 * 3 * 1.2));
    });
});

describe("imageNodeWantsFullResolution 迟滞切档", () => {
    test("缩略图档：超过升档阈值才切原图", () => {
        expect(imageNodeWantsFullResolution(IMAGE_THUMB_FULL_UPGRADE_PX, false)).toBe(false);
        expect(imageNodeWantsFullResolution(IMAGE_THUMB_FULL_UPGRADE_PX + 1, false)).toBe(true);
    });

    test("原图档：降到降档阈值以下才回缩略图", () => {
        expect(imageNodeWantsFullResolution(IMAGE_THUMB_FULL_DOWNGRADE_PX + 1, true)).toBe(true);
        expect(imageNodeWantsFullResolution(IMAGE_THUMB_FULL_DOWNGRADE_PX, true)).toBe(false);
    });

    test("迟滞区间内保持当前档位不抖动", () => {
        const mid = (IMAGE_THUMB_FULL_UPGRADE_PX + IMAGE_THUMB_FULL_DOWNGRADE_PX) / 2;
        expect(imageNodeWantsFullResolution(mid, true)).toBe(true);
        expect(imageNodeWantsFullResolution(mid, false)).toBe(false);
    });
});

describe("shouldGenerateImageThumb", () => {
    test("GIF 动图跳过", () => {
        expect(shouldGenerateImageThumb("image/gif", 4000, 3000)).toBe(false);
    });

    test("小图不生成", () => {
        expect(shouldGenerateImageThumb("image/png", 800, 600)).toBe(false);
    });

    test("大图需要生成", () => {
        expect(shouldGenerateImageThumb("image/jpeg", 4096, 3072)).toBe(true);
        expect(shouldGenerateImageThumb("image/webp", 1025, 768)).toBe(true);
    });

    test("尺寸未知（解码前）默认生成，解码后再判定", () => {
        expect(shouldGenerateImageThumb("image/png", 0, 0)).toBe(true);
    });

    test("阈值恰好为最小生成边时不生成", () => {
        expect(shouldGenerateImageThumb("image/png", 1024, 1024)).toBe(false);
    });
});

describe("档位常量", () => {
    test("升档阈值等于缩略图长边档位，降档阈值低于升档阈值", () => {
        expect(IMAGE_THUMB_FULL_UPGRADE_PX).toBe(IMAGE_THUMB_LONG_EDGE);
        expect(IMAGE_THUMB_FULL_DOWNGRADE_PX).toBeLessThan(IMAGE_THUMB_FULL_UPGRADE_PX);
    });
});

describe("imageNodeDetailTier 三档迟滞切档", () => {
    test("micro 档：超过 micro 升档阈值才升缩略图", () => {
        expect(imageNodeDetailTier(IMAGE_MICRO_THUMB_UPGRADE_PX, "micro")).toBe("micro");
        expect(imageNodeDetailTier(IMAGE_MICRO_THUMB_UPGRADE_PX + 1, "micro")).toBe("thumb");
    });

    test("thumb 档：降到 micro 降档阈值才回 micro", () => {
        expect(imageNodeDetailTier(IMAGE_MICRO_THUMB_DOWNGRADE_PX + 1, "thumb")).toBe("thumb");
        expect(imageNodeDetailTier(IMAGE_MICRO_THUMB_DOWNGRADE_PX, "thumb")).toBe("micro");
    });

    test("thumb 档：超过原图升档阈值升 full，与旧两档逻辑一致", () => {
        expect(imageNodeDetailTier(IMAGE_THUMB_FULL_UPGRADE_PX + 1, "thumb")).toBe("full");
        expect(imageNodeDetailTier(IMAGE_THUMB_FULL_UPGRADE_PX, "thumb")).toBe("thumb");
    });

    test("full 档：降到降档阈值回 thumb", () => {
        expect(imageNodeDetailTier(IMAGE_THUMB_FULL_DOWNGRADE_PX + 1, "full")).toBe("full");
        expect(imageNodeDetailTier(IMAGE_THUMB_FULL_DOWNGRADE_PX, "full")).toBe("thumb");
    });

    test("相邻档位间迟滞区间内保持当前档不抖动", () => {
        const microMid = (IMAGE_MICRO_THUMB_UPGRADE_PX + IMAGE_MICRO_THUMB_DOWNGRADE_PX) / 2;
        expect(imageNodeDetailTier(microMid, "micro")).toBe("micro");
        expect(imageNodeDetailTier(microMid, "thumb")).toBe("thumb");
        const fullMid = (IMAGE_THUMB_FULL_UPGRADE_PX + IMAGE_THUMB_FULL_DOWNGRADE_PX) / 2;
        expect(imageNodeDetailTier(fullMid, "full")).toBe("full");
        expect(imageNodeDetailTier(fullMid, "thumb")).toBe("thumb");
    });

    test("micro 档常量小于缩略图档位", () => {
        expect(IMAGE_MICRO_LONG_EDGE).toBeLessThan(IMAGE_THUMB_LONG_EDGE);
    });

    test("全档位扫描：任何当前档位与分辨率组合都返回合法档位", () => {
        const tiers: ImageDetailTier[] = ["micro", "thumb", "full"];
        for (const current of tiers) {
            for (let px = 0; px <= 2000; px += 37) {
                const next = imageNodeDetailTier(px, current);
                expect(tiers).toContain(next);
            }
        }
    });
});
