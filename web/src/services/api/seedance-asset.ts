import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { apiClient, request } from "./request";

export interface SeedanceAsset {
    id: string;
    resourceId: string;
    name: string;
    assetType: string;
    upstreamAssetId: string;
    status: "submitting" | "submitted" | "processing" | "approved" | "failed" | "expired";
    errorResponse?: string;
    approvedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface SeedanceRegisterItem {
    resourceId: string;
    channelId: string;
    model?: string;
}

export interface SeedanceRegisterResult {
    resourceId: string;
    asset?: SeedanceAsset;
    error?: string;
}

// ===== 单素材注册 =====
export function useRegisterSeedanceAsset() {
    const queryClient = useQueryClient();
    const { message } = App.useApp();
    return useMutation({
        mutationFn: ({ resourceId, channelId, model }: { resourceId: string; channelId: string; model?: string }) =>
            request<SeedanceAsset>(apiClient.post("/seedance/assets/register", { resourceId, channelId, model })),
        onSuccess: (data, { resourceId, channelId }) => {
            queryClient.setQueryData(["seedance-asset", resourceId, channelId], data);
            queryClient.invalidateQueries({ queryKey: ["seedance-asset-batch"] });
            message.success("素材已提交注册");
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "素材注册失败");
        },
    });
}

// ===== 批量注册 =====
export function useRegisterSeedanceAssetsBatch() {
    const queryClient = useQueryClient();
    const { message } = App.useApp();
    return useMutation({
        mutationFn: (items: SeedanceRegisterItem[]) =>
            request<{ results: SeedanceRegisterResult[] }>(apiClient.post("/seedance/assets/register-batch", { items })),
        onSuccess: (data, items) => {
            // 逐个更新单素材缓存
            for (const result of data.results) {
                const item = items.find((i) => i.resourceId === result.resourceId);
                if (item && result.asset) {
                    queryClient.setQueryData(["seedance-asset", result.resourceId, item.channelId], result.asset);
                }
            }
            // 失效所有批量查询缓存（用前缀匹配，不限定 resourceId 数组）
            queryClient.invalidateQueries({ queryKey: ["seedance-asset-batch"] });

            // 统计即时结果
            const successCount = data.results.filter((r) => r.asset).length;
            const failCount = data.results.filter((r) => r.error).length;
            if (failCount > 0) {
                message.warning(`${successCount} 个素材正在注册中，${failCount} 个失败`);
            } else {
                message.success(`${successCount} 个素材正在注册中，请等待审核`);
            }
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "批量注册失败");
        },
    });
}

// ===== 单素材查询（非终态时自动轮询） =====
export function useSeedanceAssetStatus(resourceId?: string, channelId?: string) {
    return useQuery({
        queryKey: ["seedance-asset", resourceId, channelId],
        queryFn: () =>
            request<SeedanceAsset | SeedanceAsset[]>(
                apiClient.get("/seedance/assets", { params: { resourceId, channelId } }),
            ).then((assets) => (Array.isArray(assets) ? assets[0] : assets)),
        enabled: Boolean(resourceId && channelId),
        refetchInterval: (query) => {
            const data = query.state.data;
            if (!data) return 2000;
            if (data.status === "submitting" || data.status === "submitted" || data.status === "processing") return 2000;
            return false;
        },
        refetchIntervalInBackground: false,
        staleTime: 1000,
    });
}

// ===== 批量查询（非终态时自动轮询） =====
export function useSeedanceAssetBatch(resourceIds: string[], channelId?: string) {
    return useQuery({
        queryKey: ["seedance-asset-batch", resourceIds, channelId],
        queryFn: () => {
            if (!resourceIds.length) return [] as SeedanceAsset[];
            return request<{ assets: SeedanceAsset[] }>(
                apiClient.get("/seedance/assets", {
                    params: { channelId, resourceIds: resourceIds.join(",") },
                }),
            ).then((data) => data.assets);
        },
        enabled: Boolean(resourceIds.length && channelId),
        refetchInterval: (query) => {
            const data = query.state.data;
            // 没有数据（素材未注册）-> 继续轮询，后端可能在注册中
            if (!Array.isArray(data) || data.length === 0) return 2000;
            // 有 pending 状态 -> 继续轮询
            const hasPending = data.some(
                (item) => item.status === "submitting" || item.status === "submitted" || item.status === "processing",
            );
            if (hasPending) return 2000;
            // 全部终态但数量不足（部分素材还没注册）-> 继续轮询
            if (data.length < resourceIds.length) return 2000;
            // 全部终态且数量匹配 -> 停止轮询
            return false;
        },
        refetchIntervalInBackground: false,
        staleTime: 1000,
    });
}

// ===== 触发重新验证 =====
export function useVerifySeedanceAsset() {
    const queryClient = useQueryClient();
    const { message } = App.useApp();
    return useMutation({
        mutationFn: ({ assetId, channelId, model }: { assetId: string; channelId: string; model?: string }) =>
            request<SeedanceAsset>(apiClient.post(`/seedance/assets/${assetId}/verify`, { channelId, model })),
        onSuccess: (data, { channelId }) => {
            queryClient.setQueryData(["seedance-asset", data.resourceId, channelId], data);
            queryClient.invalidateQueries({ queryKey: ["seedance-asset-batch"] });
            message.success("素材状态已刷新");
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "素材验证失败");
        },
    });
}
