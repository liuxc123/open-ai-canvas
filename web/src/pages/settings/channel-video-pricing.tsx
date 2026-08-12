import { useRef, useState } from "react";
import { App, Button, Drawer, Form, Input, InputNumber, Segmented, Tag, Tooltip } from "antd";
import { ChevronRight, FlaskConical, Settings2 } from "lucide-react";

import { testChannelModelConnection } from "@/lib/model-connection-test";
import { ModelCapabilityEditor } from "@/components/model-capability-editor";
import { CapabilityCardPicker, ProtocolCardPicker } from "@/components/model-protocol-picker";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { MODEL_PROTOCOLS, modelProtocolCapability, modelProtocolDefinition, type ModelProtocol } from "@/lib/model-protocols";
import { modelMatchesCapability, modelOptionName, type ModelChannel } from "@/stores/use-config-store";

type ModelCost = NonNullable<ModelChannel["modelCosts"]>[number];

export function ChannelModelSettings({ channel, onChange }: { channel: ModelChannel; onChange: (costs: ModelCost[]) => void }) {
    const { message } = App.useApp();
    const [testingModel, setTestingModel] = useState("");
    const [activeModel, setActiveModel] = useState<string | null>(null);
    const formulaTextareaRef = useRef<HTMLTextAreaElement>(null);
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
        updateCost(activeModel!, patch);
    };

    return (
        <div className="mt-3 border-t border-border/70 pt-3">
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
                    return (
                        <div key={model} className="flex min-w-0 items-center gap-3 rounded-md border border-border/70 bg-background/45 px-3 py-2.5">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-muted/35 text-foreground/65">
                                <Settings2 className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium" title={model}>
                                    {model}
                                </div>
                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                    <Tag className="mr-0 text-[var(--fs-tiny)]" bordered={false}>
                                        {capabilityLabel(capability)}
                                    </Tag>
                                    {billingMode === "formula" ? (
                                        <Tag className="mr-0 text-[var(--fs-tiny)]" color="cyan" bordered={false}>公式计费</Tag>
                                    ) : billingMode === "token" ? (
                                        <Tag className="mr-0 text-[var(--fs-tiny)]" color="cyan" bordered={false}>Token 计费</Tag>
                                    ) : billingMode === "per_second" ? (
                                        <Tag className="mr-0 text-[var(--fs-tiny)]" color="cyan" bordered={false}>按秒计费</Tag>
                                    ) : (
                                        <Tag className="mr-0 text-[var(--fs-tiny)]" color="cyan" bordered={false}>按次计费</Tag>
                                    )}
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
                    <Form layout="vertical" requiredMark={false}>
                        <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2.5">
                            <div className="text-xs font-medium">模型能力与请求协议</div>
                            <div className="mt-1 text-[var(--fs-tiny)] text-foreground/45">这些设置只影响当前渠道的这个模型，保存后会同步到生成校验。</div>
                        </div>
                        <Form.Item label="模型能力">
                            <CapabilityCardPicker
                                value={activeCapability}
                                onChange={(nextCapability) => {
                                    const nextProtocol = MODEL_PROTOCOLS.find((item) => item.value === activeProtocol && item.capability === nextCapability)?.value || MODEL_PROTOCOLS.find((item) => item.capability === nextCapability)?.value;
                                    if (!nextProtocol) return;
                                    const nextBillingMode = nextCapability === "video" ? activeBillingMode : nextCapability === "text" && activeBillingMode === "token" ? activeBillingMode : (activeBillingMode === "per_second" || activeBillingMode === "token") ? "fixed_request" : activeBillingMode;
                                    updateCost(activeModel, {
                                        protocol: nextProtocol,
                                        capability: nextCapability,
                                        billingMode: nextBillingMode,
                                        capabilityConfig: nextCapability === "image" || nextCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined,
                                    });
                                }}
                            />
                        </Form.Item>
                        <Form.Item label="请求协议">
                            <ProtocolCardPicker
                                capability={activeCapability}
                                value={activeProtocol}
                                onChange={(nextProtocol) => updateCost(activeModel, { protocol: nextProtocol, capabilityConfig: activeCapability === "image" || activeCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined })}
                            />
                        </Form.Item>
                        {activeCapability === "image" || activeCapability === "video" ? (
                            <Form.Item label={`${activeCapability === "image" ? "图片" : "视频"}能力参数`} required>
                                <ModelCapabilityEditor capability={activeCapability} model={activeModel} value={activeModelCost?.capabilityConfig || defaultModelCapabilityConfig(activeProtocol, activeModel)} protocol={activeProtocol} onChange={(capabilityConfig) => updateCost(activeModel, { capabilityConfig })} />
                            </Form.Item>
                        ) : null}
                        <Form.Item label="计费方式">
                            <Segmented
                                block
                                options={[
                                    { label: "按次计费", value: "fixed_request" },
                                    { label: "按秒计费", value: "per_second", disabled: activeCapability !== "video" },
                                    { label: "Token 计费", value: "token", disabled: activeCapability !== "text" },
                                    { label: "公式计费", value: "formula" },
                                ]}
                                value={activeBillingMode}
                                onChange={handleBillingModeChange}
                            />
                        </Form.Item>
                        {activeBillingMode === "token" ? (
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <Form.Item label="输入 / 百万 Token">
                                    <InputNumber
                                        style={{ width: "100%" }}
                                        min={0}
                                        max={1_000_000}
                                        precision={6}
                                        step={0.1}
                                        value={activeModelCost ? (activeModelCost.inputTokenPriceMicrocredits || 0) / 1_000_000 : 0}
                                        onChange={(value) => updateCost(activeModel, { inputTokenPriceMicrocredits: Math.round(Number(value || 0) * 1_000_000) })}
                                    />
                                </Form.Item>
                                <Form.Item label="输出 / 百万 Token">
                                    <InputNumber
                                        style={{ width: "100%" }}
                                        min={0}
                                        max={1_000_000}
                                        precision={6}
                                        step={0.1}
                                        value={activeModelCost ? (activeModelCost.outputTokenPriceMicrocredits || 0) / 1_000_000 : 0}
                                        onChange={(value) => updateCost(activeModel, { outputTokenPriceMicrocredits: Math.round(Number(value || 0) * 1_000_000) })}
                                    />
                                </Form.Item>
                                <Form.Item label="缓存 / 百万 Token">
                                    <InputNumber
                                        style={{ width: "100%" }}
                                        min={0}
                                        max={1_000_000}
                                        precision={6}
                                        step={0.1}
                                        value={activeModelCost ? (activeModelCost.cachedTokenPriceMicrocredits || 0) / 1_000_000 : 0}
                                        onChange={(value) => updateCost(activeModel, { cachedTokenPriceMicrocredits: Math.round(Number(value || 0) * 1_000_000) })}
                                    />
                                </Form.Item>
                            </div>
                        ) : activeBillingMode === "formula" ? (
                            <div className="space-y-2">
                                <div className="text-xs text-foreground/50">点击下方常量可插入到公式中</div>
                                <FormulaSnippetPicker textareaRef={formulaTextareaRef} />
                                <Form.Item label="计算公式">
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
                                </Form.Item>
                                <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-foreground/55 leading-5">
                                    <div className="font-medium text-foreground/70 mb-1">公式语法说明</div>
                                    <div>• <code className="text-foreground/80">body.xxx</code> 访问请求体字段，<code className="text-foreground/80">headers["X-Key"]</code> 访问请求头</div>
                                    <div>• 算术: <code>+ - * /</code> &nbsp; 比较: <code>&gt; &lt; &gt;= &lt;= == !=</code> &nbsp; 逻辑: <code>&& || !</code></div>
                                    <div>• 条件: <code>条件 ? 真值 : 假值</code>（可嵌套实现多档） &nbsp; 成员: <code>in ["a","b"]</code></div>
                                    <div>• 函数: <code>ceil floor round abs max min len</code></div>
                                    <div>• 多档示例: <code>duration &gt; 30 ? 3.0 : (duration &gt; 10 ? 2.0 : 1.0)</code></div>
                                    <div>• 匹配示例: <code>quality in ["hd","4k"] ? 2.0 : 1.0</code></div>
                                    <div>• 公式结果单位为积分，如 <code>body.duration * 0.5</code> 表示每秒 0.5 积分</div>
                                </div>
                            </div>
                        ) : (
                            <Form.Item label={activeBillingMode === "per_second" ? "每秒消耗积分" : "每次消耗积分"}>
                                <InputNumber
                                    style={{ width: "100%" }}
                                    min={0}
                                    max={1_000_000}
                                    precision={6}
                                    step={0.1}
                                    value={activeModelCost ? activeModelCost.unitPriceMicrocredits / 1_000_000 : null}
                                    onChange={(value) => updateCost(activeModel, { unitPriceMicrocredits: Math.round(Number(value || 0) * 1_000_000) })}
                                />
                            </Form.Item>
                        )}
                    </Form>
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
