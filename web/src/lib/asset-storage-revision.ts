import type { Asset } from "@/stores/use-asset-store";
import localforage from "localforage";
import { getActiveUserScope } from "@/lib/user-scope";

export type AssetStorageDocument = {
    state: { assets: Asset[] };
    version: number;
    storageRevision: number;
    tombstones: { assets: Record<string, number> };
};

export const ASSET_STORE_KEY = "infinite-canvas:asset_store";
export const ASSET_ENTRY_KEY_PREFIX = "infinite-canvas:asset";

export type AssetStorageIndex = {
    format: "sharded";
    assetIds: string[];
    version: number;
    storageRevision: number;
    tombstones: { assets: Record<string, number> };
};

const assetStore = localforage.createInstance({ name: "infinite-canvas", storeName: "asset_store" });

type AssetStorage = {
    store: typeof assetStore;
    scope: string;
    entryKey: (assetId: string) => string;
};

function assetStorageForScope(scope?: string): AssetStorage {
    const resolved = scope ?? getActiveUserScope();
    return {
        store: assetStore,
        scope: resolved,
        entryKey: (assetId: string) => `${ASSET_ENTRY_KEY_PREFIX}:user:${resolved}:${assetId}`,
    };
}

function scopedAssetKey(scope?: string) {
    const resolved = scope ?? getActiveUserScope();
    return `${ASSET_STORE_KEY}:user:${resolved}`;
}

function normalizeTombstoneMap(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

export function serializeAssetStorageIndex(index: AssetStorageIndex) {
    return JSON.stringify(index);
}

export async function loadAssetStorageDocument(scope?: string, fallback: Asset[] = []): Promise<AssetStorageDocument> {
    const { store, entryKey } = assetStorageForScope(scope);
    const raw = await store.getItem<string>(scopedAssetKey(scope));
    if (!raw) {
        return { state: { assets: fallback }, version: 0, storageRevision: 0, tombstones: { assets: {} } };
    }
    const index = parseAssetStorageIndex(raw);
    const assets = await loadShardedAssets(index.assetIds, store, entryKey);
    return {
        state: { assets },
        version: index.version,
        storageRevision: index.storageRevision,
        tombstones: { assets: index.tombstones.assets },
    };
}

function parseAssetStorageIndex(raw: string): AssetStorageIndex {
    const parsed = JSON.parse(raw) as { format?: unknown; assetIds?: unknown; version?: unknown; storageRevision?: unknown; tombstones?: { assets?: unknown } };
    if (parsed.format !== "sharded" || !Array.isArray(parsed.assetIds)) throw new Error("素材索引格式无效");
    return {
        format: "sharded",
        assetIds: parsed.assetIds as string[],
        version: typeof parsed.version === "number" ? parsed.version : 0,
        storageRevision: typeof parsed.storageRevision === "number" && Number.isFinite(parsed.storageRevision) ? parsed.storageRevision : 0,
        tombstones: { assets: normalizeTombstoneMap(parsed.tombstones?.assets) },
    };
}

async function loadShardedAssets(assetIds: string[], store: typeof assetStore, entryKey: (id: string) => string): Promise<Asset[]> {
    const results = await Promise.all(
        assetIds.map(async (id) => {
            const raw = await store.getItem<string>(entryKey(id));
            if (!raw) return null;
            try {
                return JSON.parse(raw) as Asset;
            } catch {
                return null;
            }
        }),
    );
    return results.filter((asset): asset is Asset => asset !== null);
}

export type AssetDiff = {
    upserted: Asset[];
    removed: string[];
    index: AssetStorageIndex;
};

export function diffAssetStorage(durable: AssetStorageDocument, rebased: AssetStorageDocument): AssetDiff {
    const durableById = new Map(durable.state.assets.map((asset) => [asset.id, asset]));
    const rebasedById = new Map(rebased.state.assets.map((asset) => [asset.id, asset]));
    const upserted: Asset[] = [];
    const removed: string[] = [];

    for (const asset of rebased.state.assets) {
        const prev = durableById.get(asset.id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(asset)) {
            upserted.push(asset);
        }
    }
    for (const id of durableById.keys()) {
        if (!rebasedById.has(id)) removed.push(id);
    }

    return {
        upserted,
        removed,
        index: {
            format: "sharded",
            assetIds: rebased.state.assets.map((asset) => asset.id),
            version: rebased.version,
            storageRevision: rebased.storageRevision,
            tombstones: rebased.tombstones,
        },
    };
}

export async function applyAssetDiff(scope: string, diff: AssetDiff): Promise<void> {
    const { store, entryKey } = assetStorageForScope(scope);
    const indexKey = scopedAssetKey(scope);
    await Promise.all([...diff.upserted.map((asset) => store.setItem(entryKey(asset.id), JSON.stringify(asset))), ...diff.removed.map((id) => store.removeItem(entryKey(id)))]);
    await store.setItem(indexKey, serializeAssetStorageIndex(diff.index));
}

export async function clearShardedAssetStorage(scope: string): Promise<void> {
    const { store, entryKey } = assetStorageForScope(scope);
    const indexKey = scopedAssetKey(scope);
    const raw = await store.getItem<string>(indexKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { format?: unknown; assetIds?: unknown };
    if (parsed.format !== "sharded" || !Array.isArray(parsed.assetIds)) return;
    const assetIds = parsed.assetIds as string[];
    await Promise.all([...assetIds.map((id) => store.removeItem(entryKey(id)))]);
    await store.removeItem(indexKey);
}

export async function hasAssetStorage(scope?: string): Promise<boolean> {
    const { store } = assetStorageForScope(scope);
    return Boolean(await store.getItem<string>(scopedAssetKey(scope)));
}

function deepEqual(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeValue(base: unknown, local: unknown, durable: unknown): unknown {
    if (deepEqual(local, base)) return durable;
    if (deepEqual(durable, base)) return local;
    if (isRecord(base) && isRecord(local) && isRecord(durable)) return mergeRecord(base, local, durable);
    if (!isRecord(base) && isRecord(local) && isRecord(durable)) return mergeRecord({}, local, durable);
    return durable;
}

function mergeRecord(base: Record<string, unknown>, local: Record<string, unknown>, durable: Record<string, unknown>) {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(durable)])) {
        const baseHas = Object.prototype.hasOwnProperty.call(base, key);
        const localHas = Object.prototype.hasOwnProperty.call(local, key);
        const durableHas = Object.prototype.hasOwnProperty.call(durable, key);
        if (!localHas && baseHas) {
            if (durableHas && !deepEqual(durable[key], base[key])) merged[key] = durable[key];
            continue;
        }
        if (!localHas) {
            if (durableHas) merged[key] = durable[key];
            continue;
        }
        if (!baseHas) {
            merged[key] = durableHas ? mergeValue(undefined, local[key], durable[key]) : local[key];
            continue;
        }
        if (!durableHas) {
            if (!deepEqual(local[key], base[key])) merged[key] = local[key];
            continue;
        }
        merged[key] = mergeValue(base[key], local[key], durable[key]);
    }
    return merged;
}

export function rebaseAssetSnapshot(input: { document: AssetStorageDocument; baseAssets: Asset[]; localAssets: Asset[]; baseRevision: number }) {
    const nextRevision = input.document.storageRevision + 1;
    const tombstones = { assets: { ...input.document.tombstones.assets } };
    const baseById = new Map(input.baseAssets.map((asset) => [asset.id, asset]));
    const localById = new Map(input.localAssets.map((asset) => [asset.id, asset]));
    const durableById = new Map(input.document.state.assets.map((asset) => [asset.id, asset]));
    const assets = [...input.document.state.assets];
    const positions = new Map(assets.map((asset, index) => [asset.id, index]));

    const remove = (id: string) => {
        const index = positions.get(id);
        if (index === undefined) return;
        assets.splice(index, 1);
        positions.clear();
        assets.forEach((asset, position) => positions.set(asset.id, position));
    };
    const set = (asset: Asset) => {
        const index = positions.get(asset.id);
        if (index === undefined) {
            positions.set(asset.id, assets.length);
            assets.push(asset);
        } else {
            assets[index] = asset;
        }
    };

    for (const id of new Set([...baseById.keys(), ...localById.keys()])) {
        const base = baseById.get(id);
        const local = localById.get(id);
        const durable = durableById.get(id);

        if (base && !local) {
            remove(id);
            tombstones.assets[id] = nextRevision;
            continue;
        }
        if (!local || (base && deepEqual(base, local))) continue;
        if (!durable) {
            if (base || (tombstones.assets[id] ?? 0) > input.baseRevision) continue;
            delete tombstones.assets[id];
            set(local);
            continue;
        }
        delete tombstones.assets[id];
        set(mergeRecord((base || {}) as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>, durable as unknown as Record<string, unknown>) as unknown as Asset);
    }

    return {
        state: { assets },
        version: input.document.version,
        storageRevision: nextRevision,
        tombstones,
    } satisfies AssetStorageDocument;
}
