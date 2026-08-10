import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button, Tooltip } from "antd";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";

import { useSeedanceAssetBatch, useRegisterSeedanceAssetsBatch } from "@/services/api/seedance-asset";
import { isSeedanceVideoConfig, isArkPlanBaseUrl } from "@/lib/seedance-video";
import { resolveModelChannel, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

function resourceIdFromReference(ref: CanvasResourceReference): string | undefined {
    if (!ref.storageKey?.startsWith("resource:")) return undefined;
    return ref.storageKey.replace("resource:", "");
}

export function SeedanceVideoPrecheck({
    references,
    config,
}: {
    references: CanvasResourceReference[];
    config: AiConfig;
}) {
    const isSeedance = isSeedanceVideoConfig(config) || isArkPlanBaseUrl(config.baseUrl);
    const channel = resolveModelChannel(config, config.model);
    const channelId = channel.scope === "system" ? channel.id : "";
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);

    const resourceIds = useMemo(
        () => references.map(resourceIdFromReference).filter((id): id is string => Boolean(id)),
        [references],
    );

    const { data: assets } = useSeedanceAssetBatch(resourceIds, isSeedance ? channelId : undefined);
    const registerBatch = useRegisterSeedanceAssetsBatch();

    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };
        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    if (!isSeedance || resourceIds.length === 0) return null;

    // 后端按 updated_at desc 返回，同 resourceId 取第一条（最新），避免旧记录覆盖
    const statusMap = new Map<string, NonNullable<typeof assets>[number]>();
    for (const a of assets ?? []) {
        if (!statusMap.has(a.resourceId)) statusMap.set(a.resourceId, a);
    }
    const refTitle = (id: string) => references.find((r) => resourceIdFromReference(r) === id)?.title || "素材";
    const refLabel = (id: string) => references.find((r) => resourceIdFromReference(r) === id)?.label || "素材";

    const unregistered = resourceIds.filter((id) => !statusMap.get(id));
    const pending = (assets ?? []).filter((a) => a.status === "submitting" || a.status === "submitted" || a.status === "processing");
    const failed = (assets ?? []).filter((a) => a.status === "failed" || a.status === "expired");
    const approved = (assets ?? []).filter((a) => a.status === "approved");
    const allApproved = unregistered.length === 0 && pending.length === 0 && failed.length === 0;

    // 全部通过：单行
    if (allApproved) {
        return (
            <div className="flex !h-7 items-center gap-1 rounded-full px-2.5 text-[var(--fs-tiny)] font-normal" style={{ background: theme.node.fill, color: "#16a34a" }}>
                <CheckCircle2 size={12} /> 素材已就绪
            </div>
        );
    }

    const handleRegister = () => {
        if (!channelId) return;
        const toRegister = [...unregistered, ...failed.map((a) => a.resourceId)];
        if (toRegister.length === 0) return;
        registerBatch.mutate(toRegister.map((id) => ({ resourceId: id, channelId, model: modelOptionName(config.model) })));
    };

    const canRegister = Boolean(channelId) && (unregistered.length > 0 || failed.length > 0);

    // 摘要标签片段
    const summaryParts: Array<{ color: string; text: string }> = [];
    if (approved.length > 0) summaryParts.push({ color: "#16a34a", text: `${approved.length} 通过` });
    if (pending.length > 0) summaryParts.push({ color: "#ca8a04", text: `${pending.length} 审核中` });
    if (unregistered.length > 0) summaryParts.push({ color: "#78716c", text: `${unregistered.length} 未注册` });
    if (failed.length > 0) summaryParts.push({ color: "#dc2626", text: `${failed.length} 失败` });

    const summaryText = summaryParts.map((p) => p.text).join(" · ");

    // 分组
    type GroupItem = { resourceId: string; label: string; title: string; error?: string };
    type Group = { label: string; color: string; Icon: typeof CheckCircle2; items: GroupItem[] };
    const groups: Group[] = [];
    if (unregistered.length > 0) groups.push({ label: "未注册", color: "#78716c", Icon: CircleDashed, items: unregistered.map((id) => ({ resourceId: id, label: refLabel(id), title: refTitle(id) })) });
    if (pending.length > 0) groups.push({ label: "审核中", color: "#ca8a04", Icon: Loader2, items: pending.map((a) => ({ resourceId: a.resourceId, label: refLabel(a.resourceId), title: refTitle(a.resourceId) })) });
    if (failed.length > 0) groups.push({ label: "失败", color: "#dc2626", Icon: XCircle, items: failed.map((a) => ({ resourceId: a.resourceId, label: refLabel(a.resourceId), title: refTitle(a.resourceId), error: a.errorResponse })) });
    if (approved.length > 0) groups.push({ label: "已通过", color: "#16a34a", Icon: CheckCircle2, items: approved.map((a) => ({ resourceId: a.resourceId, label: refLabel(a.resourceId), title: refTitle(a.resourceId) })) });

    const popover = open && buttonRect ? (
        <SeedancePrecheckPopover
            buttonRect={buttonRect}
            panelRef={panelRef}
            theme={theme}
            groups={groups}
            canRegister={canRegister}
            registerLoading={registerBatch.isPending}
            onRegister={handleRegister}
            registerLabel={failed.length > 0 && unregistered.length === 0 ? "重新注册失败素材" : "注册全部素材"}
        />
    ) : null;

    return (
        <>
            <Tooltip title={summaryText}>
                <span ref={buttonRef} className="inline-flex">
                    <Button
                        size="small"
                        type="text"
                        className="!h-7 !rounded-full !border-0 !px-2.5 !text-[var(--fs-tiny)] !font-normal !shadow-none"
                        style={{ background: theme.node.fill, color: theme.node.muted }}
                        aria-label={`素材审核状态：${summaryText}`}
                        onClick={() => setOpen((v) => !v)}
                    >
                        <span className="flex items-center gap-1.5">
                            {summaryParts.map((part, i) => (
                                <span key={i} className="inline-flex items-center gap-0.5" style={{ color: part.color }}>
                                    {part.text}
                                </span>
                            ))}
                        </span>
                    </Button>
                </span>
            </Tooltip>
            {popover}
        </>
    );
}

function SeedancePrecheckPopover({
    buttonRect,
    panelRef,
    theme,
    groups,
    canRegister,
    registerLoading,
    onRegister,
    registerLabel,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    groups: Array<{ label: string; color: string; Icon: typeof CheckCircle2; items: Array<{ resourceId: string; label: string; title: string; error?: string }> }>;
    canRegister: boolean;
    registerLoading: boolean;
    onRegister: () => void;
    registerLabel: string;
}) {
    const gap = 8;
    const margin = 12;
    const width = Math.min(320, window.innerWidth - margin * 2);
    const left = buttonRect.left;
    const bottomSpace = window.innerHeight - buttonRect.bottom - gap - margin;
    const topSpace = buttonRect.top - gap - margin;
    const placeAbove = bottomSpace < 200 && topSpace > bottomSpace;
    const style = {
        position: "fixed" as const,
        zIndex: "var(--z-popover)",
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(placeAbove
            ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(200, topSpace) }
            : { top: buttonRect.bottom + gap, maxHeight: Math.max(200, bottomSpace) }),
        background: theme.canvas.background,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 10,
        boxShadow: `0 24px 72px ${theme.spatial.shadow}`,
        overflowY: "auto" as const,
        color: theme.node.text,
    };

    return createPortal(
        <div
            ref={panelRef}
            className="aceternity-floating-panel backdrop-blur-2xl"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <div className="p-2.5">
                <div className="mb-1.5 text-[var(--fs-nano)] font-semibold">素材审核状态</div>
                <div className="thin-scrollbar space-y-2 overflow-y-auto" style={{ maxHeight: "calc(var(--max-h, 300px) - 60px)" }}>
                    {groups.map((group) => (
                        <div key={group.label}>
                            <div className="mb-0.5 flex items-center gap-1 text-[var(--fs-nano)] font-semibold opacity-50">
                                <group.Icon size={9} className={group.Icon === Loader2 ? "animate-spin" : ""} />
                                {group.label}（{group.items.length}）
                            </div>
                            {group.items.map((item) => (
                                <div key={item.resourceId} className="py-0.5 pl-3.5">
                                    <div className="flex items-center gap-1 text-[var(--fs-nano)]" style={{ color: group.color }}>
                                        <group.Icon size={8} className={group.Icon === Loader2 ? "animate-spin shrink-0" : "shrink-0"} />
                                        <Tooltip title={item.title !== item.label ? item.title : undefined} mouseEnterDelay={0.3}>
                                            <span className="truncate">{item.label}</span>
                                        </Tooltip>
                                    </div>
                                    {item.error ? (
                                        <Tooltip title={item.error} mouseEnterDelay={0.3}>
                                            <div className="mt-0.5 flex items-center gap-0.5 pl-3 text-[var(--fs-nano)] leading-tight opacity-60" style={{ color: group.color }}>
                                                <span className="truncate">{item.error}</span>
                                            </div>
                                        </Tooltip>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
                {canRegister ? (
                    <Button
                        size="small"
                        type="primary"
                        className="!mt-3 !w-full"
                        loading={registerLoading}
                        onClick={onRegister}
                    >
                        {registerLabel}
                    </Button>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}

export function useSeedanceVideoPrecheckBlocking(
    references: CanvasResourceReference[],
    config: AiConfig,
): { blocked: boolean; reason: string } {
    const isSeedance = isSeedanceVideoConfig(config) || isArkPlanBaseUrl(config.baseUrl);
    const channel = resolveModelChannel(config, config.model);
    const channelId = channel.scope === "system" ? channel.id : "";

    const resourceIds = useMemo(
        () => references.map(resourceIdFromReference).filter((id): id is string => Boolean(id)),
        [references],
    );

    const { data: assets } = useSeedanceAssetBatch(resourceIds, isSeedance ? channelId : undefined);

    if (!isSeedance || resourceIds.length === 0) return { blocked: false, reason: "" };

    // 后端按 updated_at desc 返回，同 resourceId 只取第一条（最新）
    const latestAssets: NonNullable<typeof assets> = [];
    const seen = new Set<string>();
    for (const a of assets ?? []) {
        if (!seen.has(a.resourceId)) {
            seen.add(a.resourceId);
            latestAssets.push(a);
        }
    }

    const pending = latestAssets.some((a) => a.status === "submitted" || a.status === "processing" || a.status === "submitting");
    const failed = latestAssets.some((a) => a.status === "failed" || a.status === "expired");

    if (pending) return { blocked: true, reason: "等待素材审核完成" };
    if (failed) return { blocked: true, reason: "素材审核失败，请重新注册" };
    return { blocked: false, reason: "" };
}
