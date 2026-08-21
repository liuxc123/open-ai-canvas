import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { apiClient, request } from "@/services/api/request";

const api = apiClient;

export type RemoteUserDataSummary = {
    id: string;
    kind?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
};

export type RemoteUserDataSnapshot = {
    assets: Asset[];
    projects: CanvasProject[];
};

export function getRemoteUserDataSnapshot() {
    return request<RemoteUserDataSnapshot>(api.get("/user-data/snapshot"));
}

export function listRemoteAssets() {
    return request<{ assets: RemoteUserDataSummary[] }>(api.get("/assets"));
}

export function batchGetRemoteAssets(ids: string[]) {
    return request<{ assets: Asset[] }>(api.post("/assets/batch-get", { ids }));
}

// 单条详情读取复用批量接口，避免恢复旧的逐条请求端点。
export async function getRemoteAsset(id: string) {
    const { assets } = await batchGetRemoteAssets([id]);
    return { asset: assets[0] };
}

export function batchUpsertRemoteAssets(assets: Asset[]) {
    return request<{ assets: RemoteUserDataSummary[] }>(api.post("/assets/batch-upsert", { assets }));
}

export function deleteRemoteAsset(id: string) {
    return request<{ id: string }>(api.delete(`/assets/${encodeURIComponent(id)}`));
}

export function listRemoteCanvasProjects() {
    return request<{ projects: RemoteUserDataSummary[] }>(api.get("/canvas-projects"));
}

export function batchGetRemoteCanvasProjects(ids: string[]) {
    return request<{ projects: CanvasProject[] }>(api.post("/canvas-projects/batch-get", { ids }));
}

export function batchUpsertRemoteCanvasProjects(projects: CanvasProject[]) {
    return request<{ projects: RemoteUserDataSummary[] }>(api.post("/canvas-projects/batch-upsert", { projects }));
}

export function deleteRemoteCanvasProject(id: string) {
    return request<{ id: string }>(api.delete(`/canvas-projects/${encodeURIComponent(id)}`));
}
