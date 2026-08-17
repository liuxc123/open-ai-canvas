import { useRef, useState } from "react";
import { App, Button, Drawer, Input, InputNumber, Segmented, Tag, Tooltip } from "antd";
import { ChevronRight, FlaskConical, Settings2 } from "lucide-react";

import { testChannelModelConnection } from "@/lib/model-connection-test";
import { ModelCapabilityEditor } from "@/components/model-capability-editor";
import { CapabilityCardPicker, ProtocolCardPicker } from "@/components/model-protocol-picker";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { MODEL_PROTOCOLS, modelProtocolCapability, modelProtocolDefinition, modelProtocolSupportsTokenBilling, type ModelProtocol } from "@/lib/model-protocols";
import { modelMatchesCapability, modelOptionName, type ModelChannel } from "@/stores/use-config-store";

type ModelCost = NonNullable<ModelChannel["modelCosts"]>[number];

export function ChannelModelSettings({ channel, onChange }: { channel: ModelChannel; onChange: (costs: ModelCost[]) => void }) {
    const { message } = App.useApp();
    const [testingModel, setTestingModel] = useState("");
    const formulaTextareaRef = useRef<HTMLTextAreaElement>(null);
    const [activeModel, setActiveModel] = useState<string | null>(null);
    if (!channel.models.length) return null;

    const updateCost = (model: string, patch: Partial<ModelCost>) => {
        const current = channel.modelCosts?.find((item) => item.model === model) || {
            model,
            capability: modelProtocolCapability(defaultProtocolForModel(channel, model)) || "text",
            protocol: defaultProtocolForModel(channel, model),
            billingMode: "fixed_request" as const,
            unitPriceMicrocredits: 0,
            capabilityConfig: defaultModelCapabilityConfig(defaultProtocolForModel(channel, model), model),
        };
        const next = [...(channel.modelCosts || []).filter((item) => item.model !== model), { ...current, ...patch, model }];
        onChange(next.filter((item) => channel.models.includes(item.model)));
    };

    const testModel = async (model: string, capability: ModelCost["capability"], protocol: ModelProtocol) => {
        setTestingModel(model);
        try {
            const detail = await testChannelModelConnection(channel, model, capability, protocol);
            message.success(`模型测试通过：${detail}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型测试失败");
        } finally {
            setTestingModel("");
        }
    };

    const activeModelCost = activeModel ? channel.modelCosts?.find((item) => item.model === activeModel) : undefined;
    const activeProtocol = activeModel ? activeModelCost?.protocol || defaultProtocolForModel(channel, activeModel) : undefined;
    const activeCapability = activeModel ? activeModelCost?.capability || modelProtocolCapability(activeProtocol) || "text" : undefined;
    const activeBillingMode = activeModelCost?.billingMode || "fixed_request";
    const activeTokenBillingSupported = modelProtocolSupportsTokenBilling(activeCapability, activeProtocol);

    const handleBillingModeChange = (value: string | number) => {
        const mode = value as ModelCost["billingMode"];
        const patch: Partial<ModelCost> = { billingMode: mode };
        if (mode !== "formula") patch.formulaConfig = undefined;
        if (mode !== "fixed_request" && mode !== "per_second") patch.unitPriceMicrocredits = 0;
        if (mode !== "token") {
            patch.inputTokenPriceMicrocredits = 0;
            patch.outputTokenPriceMicrocredits = 0;
            patch.cachedTokenPriceMicrocredits = 0;
        }
        updateCost(activeModel || "", patch);
    };

    return (
        <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                    <div className="text-xs font-medium">模型能力与请求协议</div>
                    <div className="mt-0.5 text-[var(--fs-tiny)] text-foreground/42">与运营后台使用同一能力目录；测试会发起真实请求并可能产生供应商费用</div>
                </div>
                <span className="text-[var(--fs-tiny)] text-foreground/35">{channel.models.length} 个模型</span>
            </div>
            <div className="space-y-2">
                {channel.models.map((rawModel) => {
                    const model = modelOptionName(rawModel);
                    const cost = channel.modelCosts?.find((item) => item.model === model);
                    const protocol = cost?.protocol || defaultProtocolForModel(channel, model);
                    const capability = cost?.capability || modelProtocolCapability(protocol) || "text";
                    const billingMode = cost?.billingMode || "fixed_request";
                    const displayName = cost?.displayName?.trim() || model;
                    return (
                        <div key={model} className="flex min-w-0 items-center gap-3 rounded-md bg-surface-active px-3 py-2.5 transition-colors hover:bg-surface-hover">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/[.045] text-foreground/65">
                                <Settings2 className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium" title={displayName === model ? model : `${displayName} (${model})`}>
                                    {displayName}
                                </div>
                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                    <Tag className="mr-0 text-[var(--fs-tiny)]" bordered={false}>
                                        {capabilityLabel(capability)}
                                    </Tag>
                                    <span className="truncate font-mono text-[var(--fs-tiny)] text-foreground/40" title={modelProtocolDefinition(protocol)?.create}>
                                        {modelProtocolDefinition(protocol)?.create || "待配置请求协议"}
                                    </span>
                                </div>
                            </div>
                            <Button type="text" size="small" icon={<ChevronRight className="size-4" />} iconPosition="end" onClick={() => setActiveModel(model)}>
                                配置使用
                            </Button>
                        </div>
                    );
                })}
            </div>
            <Drawer
                title={activeModel ? `${activeModel} · 使用配置` : "模型使用配置"}
                open={Boolean(activeModel)}
                onClose={() => setActiveModel(null)}
                size="min(720px, 100vw)"
                destroyOnHidden
                extra={
                    activeModel && activeCapability && activeProtocol ? (
                        <Button
                            size="small"
                            icon={<FlaskConical className="size-3.5" />}
                            loading={testingModel === activeModel}
                            disabled={Boolean(testingModel && testingModel !== activeModel)}
                            onClick={() => void testModel(activeModel, activeCapability, activeProtocol)}
                        >
                            测试模型
                        </Button>
                    ) : null
                }
            >
                {activeModel && activeCapability && activeProtocol ? (
                    <div className="space-y-4">
                        <div className="rounded-md bg-surface-active px-3 py-2.5">
                            <div className="text-xs font-medium">模型能力与请求协议</div>
                            <div className="mt-1 text-[var(--fs-tiny)] text-foreground/45">这些设置只影响当前渠道的这个模型，保存后会同步到生成校验。</div>
                        </div>
                        <section className="space-y-2">
                            <div className="text-xs font-medium">模型能力</div>
                            <CapabilityCardPicker
                                value={activeCapability}
                                onChange={(nextCapability) => {
                                    const nextProtocol = MODEL_PROTOCOLS.find((item) => item.value === activeProtocol && item.capability === nextCapability)?.value || MODEL_PROTOCOLS.find((item) => item.capability === nextCapability)?.value;
                                    if (!nextProtocol) return;
                                    updateCost(activeModel, {
                                        protocol: nextProtocol,
                                        capability: nextCapability,
                                        billingMode: activeBillingMode === "formula" ? "formula" : activeBillingMode === "per_second" && nextCapability === "video" ? "per_second" : activeBillingMode === "token" && modelProtocolSupportsTokenBilling(nextCapability, nextProtocol) ? "token" : "fixed_request",
                                        capabilityConfig: nextCapability === "image" || nextCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined,
                                    });
                                }}
                            />
                        </section>
                        <section className="space-y-2">
                            <div className="text-xs font-medium">请求协议</div>
                            <ProtocolCardPicker
                                capability={activeCapability}
                                value={activeProtocol}
                                onChange={(nextProtocol) => updateCost(activeModel, { protocol: nextProtocol, billingMode: activeBillingMode === "formula" ? "formula" : activeBillingMode === "token" && !modelProtocolSupportsTokenBilling(activeCapability, nextProtocol) ? "fixed_request" : activeBillingMode, capabilityConfig: activeCapability === "image" || activeCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined })}
                            />
                        </section>
                        {activeCapability === "video" ? (
                            <div className="space-y-2">
                                <div className="text-xs font-medium">计费方式</div>
                                <div className="grid gap-2 lg:grid-cols-[176px_1fr]">
                                    <Segmented
                                        size="small"
                                        block
                                        value={activeBillingMode}
                                        options={[
                                            { label: "按次", value: "fixed_request" },
                                            { label: "按秒", value: "per_second" },
                                            { label: "Token", value: "token", disabled: !activeTokenBillingSupported },
                                            { label: "公式", value: "formula" },
                                        ]}
                                        onChange={handleBillingModeChange}
                                    />
                                    {activeBillingMode === "formula" ? (
                                        <div className="space-y-1.5">
                                            <FormulaSnippetPicker textareaRef={formulaTextareaRef} />
                                            <Input.TextArea
                                                ref={(node) => {
                                                    const native = node?.nativeElement;
                                                    if (native && native.tagName === "TEXTAREA") {
                                                        (formulaTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = native as HTMLTextAreaElement;
                                                    }
                                                }}
                                                autoSize={{ minRows: 2, maxRows: 6 }}
                                                placeholder="例如：body.duration * 0.5"
                                                value={activeModelCost?.formulaConfig?.formula || ""}
                                                onChange={(event) => updateCost(activeModel, { formulaConfig: { formula: event.target.value } })}
                                            />
                                        </div>
                                    ) : (
                                        <InputNumber
                                            size="small"
                                            min={0}
                                            max={1_000_000}
                                            precision={6}
                                            step={0.1}
                                            className="w-full"
                                            placeholder={activeBillingMode === "token" ? "每百万视频 Token 价格" : activeBillingMode === "per_second" ? "每秒价格" : "每次价格"}
                                            addonAfter={`积分/${activeBillingMode === "token" ? "百万 Token" : activeBillingMode === "per_second" ? "秒" : "次"}`}
                                            value={activeModelCost ? (activeBillingMode === "token" ? (activeModelCost.outputTokenPriceMicrocredits || 0) : activeModelCost.unitPriceMicrocredits) / 1_000_000 : null}
                                            onChange={(value) => updateCost(activeModel, activeBillingMode === "token" ? { outputTokenPriceMicrocredits: Math.round(Number(value || 0) * 1_000_000) } : { unitPriceMicrocredits: Math.round(Number(value || 0) * 1_000_000) })}
                                        />
                                    )}
                                </div>
                                {activeBillingMode === "token" ? <div className="text-[var(--fs-tiny)] text-foreground/45">按火山方舟任务查询响应的 usage.completion_tokens 结算。</div> : null}
                            </div>
                        ) : null}
                        {activeCapability === "image" || activeCapability === "video" ? (
                            <ModelCapabilityEditor capability={activeCapability} model={activeModel} value={activeModelCost?.capabilityConfig || defaultModelCapabilityConfig(activeProtocol, activeModel)} protocol={activeProtocol} onChange={(capabilityConfig) => updateCost(activeModel, { capabilityConfig })} />
                        ) : null}
                    </div>
                ) : null}
            </Drawer>
        </div>
    );
}

function defaultProtocolForModel(channel: ModelChannel, model: string): ModelProtocol {
    if (channel.interfaceType) return channel.interfaceType;
    if (channel.apiFormat === "gemini" && modelMatchesCapability(model, "video")) return "gemini-veo";
    if (modelMatchesCapability(model, "video")) return "newapi";
    if (modelOptionName(model).trim().toLowerCase().startsWith("grok-imagine-image")) return "grok-image";
    if (modelMatchesCapability(model, "image")) return "openai-image";
    return "chat-completion";
}

function capabilityLabel(value: ModelCost["capability"]) {
    return { text: "文本", image: "图片", video: "视频", audio: "音频", "": "待配置" }[value] || "待配置";
}

// ── 公式常量/变量快速选择 ──────────────────────────────────────────

type FormulaSnippet = {
    label: string;
    snippet: string;
    tip?: string;
};

type FormulaSnippetGroup = {
    title: string;
    items: FormulaSnippet[];
};

const FORMULA_SNIPPET_GROUPS: FormulaSnippetGroup[] = [
    {
        title: "请求体",
        items: [
            { label: "duration", snippet: "body.duration", tip: "视频时长（秒）" },
            { label: "seconds", snippet: "body.seconds", tip: "视频时长（秒），NewAPI Video Generations / Grok 使用此字段" },
            { label: "resolution", snippet: 'body.resolution', tip: "视频分辨率，如 480p、720p、1080p、2160p" },
            { label: "width", snippet: "body.width", tip: "图片/视频宽度" },
            { label: "height", snippet: "body.height", tip: "图片/视频高度" },
            { label: "size", snippet: 'body.size', tip: "尺寸字符串，如 1024x1024" },
            { label: "quality", snippet: 'body.quality', tip: "质量参数" },
            { label: "n", snippet: "body.n", tip: "生成数量" },
            { label: "model", snippet: 'body.model', tip: "模型名称" },
            { label: "max_tokens", snippet: "body.max_tokens", tip: "最大输出 Token 数" },
            { label: "temperature", snippet: "body.temperature", tip: "温度参数" },
        ],
    },
    {
        title: "请求头",
        items: [
            { label: "Content-Type", snippet: 'headers["Content-Type"]', tip: "请求内容类型" },
            { label: "X-Custom-*", snippet: 'headers["X-Custom-Key"]', tip: "自定义请求头（替换 Key）" },
        ],
    },
    {
        title: "运算符",
        items: [
            { label: "+", snippet: " + " },
            { label: "-", snippet: " - " },
            { label: "*", snippet: " * " },
            { label: "/", snippet: " / " },
            { label: ">", snippet: " > " },
            { label: "<", snippet: " < " },
            { label: ">=", snippet: " >= " },
            { label: "<=", snippet: " <= " },
            { label: "==", snippet: " == " },
            { label: "!=", snippet: " != " },
            { label: "&&", snippet: " && " },
            { label: "||", snippet: " || " },
            { label: "!", snippet: "!" },
            { label: "in", snippet: " in ", tip: '值 in [a, b, c]，如 quality in ["hd","4k"]' },
            { label: "?:", snippet: " ?  : ", tip: "条件 ? 真值 : 假值" },
        ],
    },
    {
        title: "函数",
        items: [
            { label: "ceil", snippet: "ceil()", tip: "向上取整" },
            { label: "floor", snippet: "floor()", tip: "向下取整" },
            { label: "round", snippet: "round()", tip: "四舍五入" },
            { label: "abs", snippet: "abs()", tip: "绝对值" },
            { label: "max", snippet: "max(, )", tip: "取较大值" },
            { label: "min", snippet: "min(, )", tip: "取较小值" },
            { label: "len", snippet: "len()", tip: "数组长度" },
        ],
    },
];

function FormulaSnippetPicker({ textareaRef }: { textareaRef: React.RefObject<HTMLTextAreaElement | null> }) {
    const insertSnippet = (snippet: string) => {
        const el = textareaRef.current;
        if (!el) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const before = el.value.slice(0, start);
        const after = el.value.slice(end);
        // 对于带括号的函数，将光标放在括号内
        const cursorOffset = snippet.includes("()") ? snippet.indexOf(")") : snippet.includes("(, )") ? snippet.indexOf(", ") + 2 : snippet.length;
        const newValue = before + snippet + after;
        // 使用 nativeInputValueSetter 绕过 React 受控组件限制
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) {
            nativeSetter.call(el, newValue);
        }
        el.selectionStart = el.selectionEnd = start + cursorOffset;
        el.focus();
        // 触发 React 的 onChange
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    return (
        <div className="space-y-1.5">
            {FORMULA_SNIPPET_GROUPS.map((group) => (
                <div key={group.title} className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[var(--fs-micro)] font-medium text-foreground/40 select-none">{group.title}</span>
                    {group.items.map((item) => (
                        <Tooltip key={item.label + item.snippet} title={item.tip || item.snippet} mouseEnterDelay={0.4}>
                            <Tag
                                className="cursor-pointer !m-0 !px-1.5 !text-[var(--fs-micro)] !font-mono !leading-[20px] transition-colors hover:!bg-primary/10 hover:!text-primary hover:!border-primary/30"
                                onClick={() => insertSnippet(item.snippet)}
                            >
                                {item.label}
                            </Tag>
                        </Tooltip>
                    ))}
                </div>
            ))}
        </div>
    );
}
