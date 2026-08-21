import { afterAll, beforeAll, expect, test } from "bun:test";

import { apiClient } from "../src/services/api/request";
import { waitForGenerationTask, type GenerationTask } from "../src/services/api/task-center";

// biome-ignore lint/suspicious/noExplicitAny: 测试环境补齐/恢复全局对象
const globalScope = globalThis as any;
const originalWindow = globalScope.window;
const originalCustomEvent = globalScope.CustomEvent;

beforeAll(() => {
    globalScope.window = {
        setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
        clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
        dispatchEvent: () => true,
    };
    globalScope.CustomEvent = class {
        readonly type: string;
        constructor(type: string) {
            this.type = type;
        }
    };
});

afterAll(() => {
    globalScope.window = originalWindow;
    globalScope.CustomEvent = originalCustomEvent;
});

function stubApi(task: GenerationTask) {
    const posts: string[] = [];
    const originalGet = apiClient.get.bind(apiClient);
    const originalPost = apiClient.post.bind(apiClient);
    const envelope = { data: { code: 0, data: task, msg: "" } };
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩替换 axios 方法
    (apiClient as any).get = async () => envelope;
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩替换 axios 方法
    (apiClient as any).post = async (url: string) => {
        posts.push(String(url));
        return envelope;
    };
    return {
        posts,
        restore() {
            // biome-ignore lint/suspicious/noExplicitAny: 测试桩替换 axios 方法
            (apiClient as any).get = originalGet;
            // biome-ignore lint/suspicious/noExplicitAny: 测试桩替换 axios 方法
            (apiClient as any).post = originalPost;
        },
    };
}

function runningTask(): GenerationTask {
    return {
        id: "wait-abort-task-0001",
        type: "canvas_video",
        status: "running",
        prompt: "a running clip",
        attempts: 1,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
    };
}

test("aborting the wait keeps the backend task running instead of cancelling it", async () => {
    const stub = stubApi(runningTask());
    const controller = new AbortController();
    try {
        const waiting = waitForGenerationTask("wait-abort-task-0001", { signal: controller.signal, intervalMs: 5 });
        await new Promise((resolve) => setTimeout(resolve, 12));
        controller.abort();
        await expect(waiting).rejects.toThrow();
    } finally {
        stub.restore();
    }
    expect(stub.posts).toEqual([]);
});

test("explicit cancelOnAbort still cancels the backend task", async () => {
    const stub = stubApi(runningTask());
    const controller = new AbortController();
    try {
        const waiting = waitForGenerationTask("wait-abort-task-0001", { signal: controller.signal, cancelOnAbort: true, intervalMs: 5 });
        await new Promise((resolve) => setTimeout(resolve, 12));
        controller.abort();
        await expect(waiting).rejects.toThrow();
    } finally {
        stub.restore();
    }
    expect(stub.posts).toEqual(["/tasks/wait-abort-task-0001/cancel"]);
});
