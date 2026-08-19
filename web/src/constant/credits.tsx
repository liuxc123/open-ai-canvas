import type { ComponentProps } from "react";
import { Coins } from "lucide-react";

export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return (
        <span {...props} className={`inline-flex items-center justify-center ${className || ""}`}>
            <Coins className="size-[1em]" strokeWidth={2.2} />
        </span>
    );
}

export type ModelCreditCost = {
    model: string;
    billingMode: "fixed_request" | "per_second" | "token" | "formula";
    unitPriceMicrocredits: number;
    formulaConfig?: { formula: string };
};

function modelCreditCost(modelCosts: ModelCreditCost[] | undefined, model: string) {
    return modelCosts?.find((item) => item.model === model) || null;
}

export function formatCredits(value: number, maximumFractionDigits = 6) {
    return (value / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits });
}

export function requestCreditCost(options: {
    channelMode: string;
    modelCosts?: ModelCreditCost[];
    model: string;
    count?: string | number;
    seconds?: string | number;
    vquality?: string;
    size?: string;
}) {
    if (options.channelMode !== "remote") return null;
    const cost = modelCreditCost(options.modelCosts, options.model);
    if (!cost) return null;
    // Token 订单由服务端按请求体预授权并在 usage 返回后结算，前端不展示无依据的固定价格。
    if (cost.billingMode === "token") return null;
    if (cost.billingMode === "formula") {
        return evaluateFormulaCost(cost.formulaConfig?.formula || "", options);
    }
    const quantity = cost.billingMode === "per_second"
        ? Math.max(1, Math.floor(Math.abs(Number(options.seconds)) || 1))
        : Math.max(1, Math.floor(Math.abs(Number(options.count)) || 1));
    return (cost.unitPriceMicrocredits / 1_000_000) * quantity;
}

// ── 公式计费前端预估 ──────────────────────────────────────────────

function evaluateFormulaCost(formula: string, options: { seconds?: string | number; vquality?: string; size?: string; model?: string }): number | null {
    const trimmed = formula.trim();
    if (!trimmed) return null;
    const seconds = Math.max(1, Math.floor(Math.abs(Number(options.seconds)) || 1));
    const resolution = normalizeResolutionForBody(options.vquality);
    const body: Record<string, unknown> = {
        duration: seconds,
        seconds: String(seconds),
        resolution,
        size: options.size || "",
        quality: options.vquality || "",
        model: options.model || "",
    };
    try {
        const result = safeEvalFormula(trimmed, body);
        if (typeof result !== "number" || !Number.isFinite(result) || result < 0) return null;
        return result;
    } catch {
        return null;
    }
}

function normalizeResolutionForBody(vquality: string | undefined): string {
    const token = String(vquality || "").trim().toLowerCase();
    if (token === "low") return "480p";
    if (token === "auto" || token === "medium" || token === "high") return "720p";
    if (token === "4k") return "2160p";
    const num = Number(token.replace(/p$/i, ""));
    if (Number.isFinite(num) && num > 0) return `${num}p`;
    return "720p";
}

/**
 * 安全求值 expr-lang 公式（仅用于前端预估，实际计费由后端 expr-lang 执行）。
 * 语法兼容：body.xxx / headers["xxx"] / 算术 / 比较 / 逻辑 / 三元 / in / ceil floor round abs max min len
 */
function safeEvalFormula(formula: string, body: Record<string, unknown>): number {
    // 将 expr-lang 的 `X in [array]` 转换为 JS 的 `[array].includes(X)`
    const processed = convertInOperator(formula);
    const headers: Record<string, string> = {};
    const fn = new Function(
        "body", "headers",
        "ceil", "floor", "round", "abs", "max", "min", "len",
        `"use strict"; return (${processed});`,
    );
    const result = fn(
        body, headers,
        Math.ceil, Math.floor, Math.round, Math.abs, Math.max, Math.min,
        (arr: unknown) => Array.isArray(arr) ? arr.length : 0,
    );
    return Number(result);
}

function convertInOperator(formula: string): string {
    // 匹配 `表达式 in [数组字面量]` 并转换为 `[数组字面量].includes(表达式)`
    // 处理常见的 `body.resolution in ["1080p", "2160p"]` 形式
    return formula.replace(
        /([\w.$\[\]"']+)\s+in\s+(\[[^\]]*\])/g,
        '($2).includes($1)',
    );
}
