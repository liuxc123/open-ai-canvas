import { useLayoutEffect, useRef, type RefObject } from "react";
import { Group, Leafer, Path, Rect } from "leafer-ui";

import { activeConnectionPath, canvasConnectionPath } from "@/components/canvas/canvas-connections";
import type { CanvasBatchConnectionPreview } from "@/lib/canvas/canvas-batch-connection";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasSelectionPreview } from "@/lib/canvas/canvas-live-viewport";
import { calculateCanvasPreviewTransform, sameCanvasViewport, shouldRebaseCanvasRaster } from "@/lib/canvas/canvas-leafer-viewport";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasDisplayConnection, CanvasNodeData, ConnectionHandle, Position, SelectionBox, ViewportTransform } from "@/types/canvas";

type NodeBounds = { left: number; top: number; width: number; height: number; count: number } | null;

type CanvasLeaferGraphicsLayerProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    theme: CanvasTheme;
    displayConnections: CanvasDisplayConnection[];
    selectedConnectionId: string | null;
    relatedConnectionIds: Set<string>;
    scriptScrollTopById: Record<string, number>;
    connectingParams: ConnectionHandle | null;
    batchConnectionPreview: CanvasBatchConnectionPreview | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    connectionTargetAnchorRatio?: number;
    nodeById: Map<string, CanvasNodeData>;
    selectionBox: SelectionBox | null;
    selectedNodeBounds: NodeBounds;
    alignmentGuides: { vertical?: number; horizontal?: number };
};

type GraphicsScene = {
    leafer: Leafer;
    world: Group;
    host: HTMLDivElement;
    connections: Group;
    connectionPaths: Map<string, Path>;
    selection: Rect;
    selectionBounds: Rect;
    guides: Path;
    draft: Path;
    batchDrafts: Group;
    batchDraftPaths: Map<string, Path>;
};

export function CanvasLeaferGraphicsLayer(props: CanvasLeaferGraphicsLayerProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<GraphicsScene | null>(null);
    const viewportRef = useRef(props.viewport);
    const rasterViewportRef = useRef(props.viewport);
    const propsRef = useRef(props);
    propsRef.current = props;

    useLayoutEffect(() => {
        const host = hostRef.current;
        // 子组件 layout effect 可能早于父层 ref 对外可见，host 的直接父元素才是此刻最可靠的画布容器。
        const container = (props.containerRef.current || host?.parentElement) as HTMLDivElement | null;
        if (!host || !container) return;

        const scene = createGraphicsScene(host);
        sceneRef.current = scene;

        const resize = () => {
            const rect = container.getBoundingClientRect();
            const size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), pixelRatio: canvasPixelRatio() };
            scene.leafer.resize(size);
            syncViewport(rasterViewportRef.current, size.width, size.height, scene, propsRef.current);
            if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
                applyScenePreview(viewportRef.current, rasterViewportRef.current, scene);
            }
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        window.addEventListener("resize", resize);
        const unsubscribe = subscribeCanvasGraphicsViewportPreview(container, (next) => {
            viewportRef.current = next;
            const rect = container.getBoundingClientRect();
            if (isViewportPreview(container, next, rasterViewportRef.current)) {
                if (shouldRebaseCanvasRaster(next, rasterViewportRef.current)) {
                    syncViewport(next, rect.width, rect.height, scene, propsRef.current);
                    rasterViewportRef.current = next;
                    forceSceneRender(scene);
                    resetScenePreview(scene);
                    return;
                }
                applyScenePreview(next, rasterViewportRef.current, scene);
                return;
            }
            resetScenePreview(scene);
            if (sameCanvasViewport(next, rasterViewportRef.current)) return;
            syncViewport(next, rect.width, rect.height, scene, propsRef.current);
            rasterViewportRef.current = next;
        });
        const unsubscribeSelection = subscribeCanvasSelectionPreview(container, (selection) => {
            syncSelection(scene.selection, selection, propsRef.current.theme);
        });
        resize();

        return () => {
            unsubscribe();
            unsubscribeSelection();
            resizeObserver.disconnect();
            window.removeEventListener("resize", resize);
            scene.leafer.destroy(true);
            sceneRef.current = null;
        };
    }, [props.containerRef]);

    useLayoutEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        rebuildConnections(scene, props);
    }, [props.displayConnections, props.relatedConnectionIds, props.scriptScrollTopById, props.selectedConnectionId, props.theme]);

    useLayoutEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        syncOverlayContent(scene, props, viewportRef.current.k);
    }, [props.batchConnectionPreview, props.connectingParams, props.connectionTargetAnchorRatio, props.connectionTargetNodeId, props.mouseWorld, props.nodeById, props.scriptScrollTopById, props.selectedNodeBounds, props.selectionBox, props.theme]);

    useLayoutEffect(() => {
        const scene = sceneRef.current;
        const container = props.containerRef.current;
        if (!scene || !container) return;
        viewportRef.current = props.viewport;
        const rect = container.getBoundingClientRect();
        const hadPreview = hasScenePreview(scene);
        if (hadPreview || !sameCanvasViewport(props.viewport, rasterViewportRef.current)) {
            syncViewport(props.viewport, rect.width, rect.height, scene, props);
        }
        rasterViewportRef.current = props.viewport;
        // 新视口先同步到真实 DPR backing store，再撤销交互期的合成变换，避免出现跳帧。
        if (hadPreview) forceSceneRender(scene);
        resetScenePreview(scene);
    }, [props.containerRef, props.viewport]);

    useLayoutEffect(() => {
        const scene = sceneRef.current;
        const container = props.containerRef.current;
        if (!scene || !container) return;
        const rect = container.getBoundingClientRect();
        syncViewport(rasterViewportRef.current, rect.width, rect.height, scene, props);
        if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
            applyScenePreview(viewportRef.current, rasterViewportRef.current, scene);
        }
    }, [props.alignmentGuides, props.containerRef, props.theme]);

    return (
        <div ref={hostRef} data-canvas-leafer-graphics className="pointer-events-none absolute inset-0 z-[var(--z-canvas-overlay)] overflow-hidden" aria-hidden />
    );
}

function createGraphicsScene(host: HTMLDivElement): GraphicsScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true, webgl: true });
    const world = new Group({ hittable: false });
    // 连线层先添加 → 渲染在底部；覆盖层后添加 → 渲染在顶部。
    const connections = new Group({ hittable: false });
    const selection = new Rect({ visible: false, hittable: false });
    const selectionBounds = new Rect({ visible: false, hittable: false, fill: "transparent" });
    const guides = new Path({ visible: false, hittable: false });
    const draft = new Path({ visible: false, hittable: false });
    const batchDrafts = new Group({ visible: false, hittable: false });
    world.add(connections);
    world.add(selection);
    world.add(selectionBounds);
    world.add(guides);
    world.add(draft);
    world.add(batchDrafts);
    leafer.add(world);
    return { leafer, world, host, connections, connectionPaths: new Map(), selection, selectionBounds, guides, draft, batchDrafts, batchDraftPaths: new Map() };
}

function rebuildConnections(scene: GraphicsScene, props: CanvasLeaferGraphicsLayerProps) {
    const existing = scene.connectionPaths;
    const seen = new Set<string>();
    props.displayConnections.forEach(({ connection, from, to }) => {
        seen.add(connection.id);
        const emphasized = props.selectedConnectionId === connection.id || props.relatedConnectionIds.has(connection.id);
        const pathD = canvasConnectionPath(connection, from, to, props.scriptScrollTopById[from.id] || 0, props.scriptScrollTopById[to.id] || 0).pathD;
        const stroke = emphasized ? props.theme.accent.primary : props.theme.node.muted;
        const strokeWidth = emphasized ? 1.6 : 1;
        const opacity = emphasized ? 0.52 : 0.24;

        let path = existing.get(connection.id);
        if (path) {
            path.set({ path: pathD, stroke, strokeWidth, opacity });
        } else {
            path = new Path({
                path: pathD,
                stroke,
                strokeWidth,
                strokeScaleFixed: true,
                strokeCap: "round",
                opacity,
                hittable: false,
            });
            path.name = connection.id;
            scene.connections.add(path);
            existing.set(connection.id, path);
        }
    });
    if (existing.size !== seen.size) {
        for (const [id, path] of existing) {
            if (!seen.has(id)) {
                path.remove();
                path.destroy();
                existing.delete(id);
            }
        }
    }
}

function syncOverlayContent(scene: GraphicsScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const selection = props.selectionBox;
    scene.selection.visible = Boolean(selection);
    if (selection) {
        syncSelection(scene.selection, selection, props.theme);
    }

    const bounds = props.selectedNodeBounds;
    scene.selectionBounds.visible = Boolean(bounds && !selection);
    if (bounds && !selection) {
        syncSelectionBounds(scene.selectionBounds, bounds, viewportScale);
        scene.selectionBounds.stroke = props.theme.accent.primary;
    }

    const connecting = props.connectingParams;
    scene.draft.visible = Boolean(connecting);
    if (connecting) {
        scene.draft.set({
            path: activeConnectionPath(
                props.nodeById.get(connecting.nodeId),
                connecting,
                props.mouseWorld,
                props.connectionTargetNodeId ? props.nodeById.get(props.connectionTargetNodeId) : undefined,
                props.scriptScrollTopById[connecting.nodeId] || 0,
                props.connectionTargetAnchorRatio,
            ),
            stroke: props.theme.accent.primary,
            strokeCap: "round",
            opacity: 0.72,
        });
    }

    const existing = scene.batchDraftPaths;
    const batch = props.batchConnectionPreview;
    scene.batchDrafts.visible = Boolean(batch);
    if (!batch) {
        if (existing.size > 0) {
            for (const [, path] of existing) {
                path.remove();
                path.destroy();
            }
            existing.clear();
        }
        return;
    }
    const target = batch.targetNodeId ? props.nodeById.get(batch.targetNodeId) : undefined;
    const stroke = batch.status === "invalid" ? props.theme.accent.danger : batch.status === "partial" ? props.theme.node.activeStroke : props.theme.accent.primary;
    const seen = new Set<string>();
    batch.sourceNodeIds.forEach((sourceNodeId) => {
        const source = props.nodeById.get(sourceNodeId);
        if (!source) return;
        seen.add(sourceNodeId);
        const handle: ConnectionHandle = { nodeId: source.id, handleType: "source" };
        const pathD = activeConnectionPath(source, handle, batch.mouseWorld, target, props.scriptScrollTopById[source.id] || 0, batch.targetAnchorRatio);

        let path = existing.get(sourceNodeId);
        if (path) {
            path.set({ path: pathD, stroke });
        } else {
            path = new Path({
                path: pathD,
                stroke,
                strokeWidth: 1.4,
                strokeScaleFixed: true,
                strokeCap: "round",
                dashPattern: [8, 8],
                opacity: 0.72,
                hittable: false,
            });
            path.name = sourceNodeId;
            scene.batchDrafts.add(path);
            existing.set(sourceNodeId, path);
        }
    });
    if (existing.size !== seen.size) {
        for (const [id, path] of existing) {
            if (!seen.has(id)) {
                path.remove();
                path.destroy();
                existing.delete(id);
            }
        }
    }
}

function syncSelection(rect: Rect, selection: SelectionBox, theme: CanvasTheme) {
    rect.set({
        x: Math.min(selection.startWorldX, selection.currentWorldX),
        y: Math.min(selection.startWorldY, selection.currentWorldY),
        width: Math.abs(selection.currentWorldX - selection.startWorldX),
        height: Math.abs(selection.currentWorldY - selection.startWorldY),
        fill: theme.canvas.selectionFill,
        stroke: theme.accent.primary,
    });
}

function syncViewport(viewport: ViewportTransform, width: number, height: number, scene: GraphicsScene, props: CanvasLeaferGraphicsLayerProps) {
    const scale = Math.max(viewport.k, 0.05);
    scene.world.set({ x: viewport.x, y: viewport.y, scaleX: scale, scaleY: scale });

    scene.selection.strokeWidth = 1 / scale;
    scene.selection.cornerRadius = 2 / scale;
    if (props.selectedNodeBounds) syncSelectionBounds(scene.selectionBounds, props.selectedNodeBounds, scale);
    scene.selectionBounds.set({ strokeWidth: 1 / scale, cornerRadius: 12 / scale });
    scene.draft.set({ strokeWidth: 1.4 / scale, dashPattern: [8 / scale, 8 / scale] });
    scene.guides.set({
        visible: typeof props.alignmentGuides.vertical === "number" || typeof props.alignmentGuides.horizontal === "number",
        path: guidePath(viewport, width, height, props.alignmentGuides),
        stroke: props.theme.accent.primary,
        strokeWidth: 1 / scale,
        dashPattern: [5 / scale, 5 / scale],
        opacity: 0.72,
    });
}

function isViewportPreview(container: HTMLDivElement, viewport: ViewportTransform, rasterViewport: ViewportTransform) {
    return container.dataset.canvasViewportInteracting === "true" && !sameCanvasViewport(viewport, rasterViewport);
}

function applyScenePreview(viewport: ViewportTransform, rasterViewport: ViewportTransform, scene: GraphicsScene) {
    // 将已栅格画面的屏幕坐标映射到实时视口，缩放手势期间不触碰 Leafer 场景树。
    const { ratio, x, y } = calculateCanvasPreviewTransform(viewport, rasterViewport);
    scene.host.style.transformOrigin = "0 0";
    scene.host.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
    scene.host.style.willChange = "transform";
    scene.host.dataset.canvasLeaferPreview = "true";
}

function hasScenePreview(scene: GraphicsScene) {
    return scene.host.dataset.canvasLeaferPreview === "true";
}

function resetScenePreview(scene: GraphicsScene) {
    scene.host.style.transform = "";
    scene.host.style.transformOrigin = "";
    scene.host.style.willChange = "";
    delete scene.host.dataset.canvasLeaferPreview;
}

function forceSceneRender(scene: GraphicsScene) {
    scene.leafer.forceRender(undefined, true);
}

function syncSelectionBounds(rect: Rect, bounds: NonNullable<NodeBounds>, viewportScale: number) {
    const padding = 12 / Math.max(viewportScale, 0.05);
    rect.set({
        x: bounds.left - padding,
        y: bounds.top - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
    });
}

function guidePath(viewport: ViewportTransform, width: number, height: number, guides: { vertical?: number; horizontal?: number }) {
    const scale = Math.max(viewport.k, 0.05);
    const left = -viewport.x / scale;
    const top = -viewport.y / scale;
    const right = left + width / scale;
    const bottom = top + height / scale;
    const commands: string[] = [];
    if (typeof guides.vertical === "number") commands.push(`M ${guides.vertical} ${top} L ${guides.vertical} ${bottom}`);
    if (typeof guides.horizontal === "number") commands.push(`M ${left} ${guides.horizontal} L ${right} ${guides.horizontal}`);
    return commands.join(" ");
}

function canvasPixelRatio() {
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}
