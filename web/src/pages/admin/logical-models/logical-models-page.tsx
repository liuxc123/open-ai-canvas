import { Alert, App, Button, Drawer, Form, Input, InputNumber, Modal, Segmented, Select, Switch, Table, Tag, Tooltip } from "antd";
import type { FormInstance } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Archive, FlaskConical, GitBranch, Layers3, Pencil, Plus, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { PaginationBar } from "@/components/layout/workspace-page";
import { ModelIconPicker, ModelLogo } from "@/components/model-logo";
import { CapabilityCardPicker } from "@/components/model-protocol-picker";
import { formatCredits } from "@/constant/credits";
import { modelProtocolSupportsTokenBilling } from "@/lib/model-protocols";
import { AdminPageFrame } from "@/pages/admin/components/admin-shell";
import { AdminDataTable, AdminFilterChip, AdminRowActions, AdminStatusBadge, AdminTableEmpty } from "@/pages/admin/components/admin-ui";
import { listAdminChannels } from "@/services/api/auth";
import { listAdminChannelModels, type ChannelModel } from "@/services/api/wallet";
import {
    createAdminLogicalModel,
    deleteAdminLogicalModel,
    listAdminLogicalModels,
    simulateAdminLogicalModel,
    updateAdminLogicalModel,
    type AdminLogicalModel,
    type CapabilitySpec,
    type LogicalModelMutation,
    type ModelRequestIntent,
    type RouteSimulationResult,
} from "@/services/api/logical-models";
import {
    CapabilityRequestEditor,
    CapabilityScopeEditor,
    CapabilitySummary,
    DefaultOptionsEditor,
    capabilityLabel,
    capabilitySpecFromChannelModel,
    capabilitySourceError,
    emptyCapabilitySpec,
    mergeCapabilitySpecs,
    normalizeCapabilitySpecForSources,
    operationLabel,
    sanitizeDefaults,
    type CapabilityKind,
} from "./model-routing-capabilities";

type RouteRuleRow = { channelModelId: string; enabled: boolean; priority: number; weight: number };
type LogicalModelFormValues = {
    code: string;
    name: string;
    icon: string;
    description: string;
    capability: CapabilityKind;
    enabled: boolean;
    sortOrder: number;
    pricePolicy: LogicalModelMutation["pricePolicy"];
    billingMode: LogicalModelMutation["billingMode"];
    unitPriceMicrocredits: number;
    inputPriceMicrocredits: number;
    outputPriceMicrocredits: number;
    cachedPriceMicrocredits: number;
    formula: string;
    capabilitySpec: CapabilitySpec;
    defaultOptions: Record<string, unknown>;
    routes: RouteRuleRow[];
};
export default function LogicalModelsPage() {
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const deferredKeyword = useDeferredValue(keyword.trim().toLowerCase());
    const [loading, setLoading] = useState(true);
    const [models, setModels] = useState<AdminLogicalModel[]>([]);
    const [channelModels, setChannelModels] = useState<ChannelModel[]>([]);
    const [channelNames, setChannelNames] = useState<Record<string, string>>({});
    const [channelEnabled, setChannelEnabled] = useState<Record<string, boolean>>({});
    const [editingModel, setEditingModel] = useState<AdminLogicalModel | null | undefined>();
    const [saving, setSaving] = useState(false);
    const [deletingModelId, setDeletingModelId] = useState<string>();
    const [simulatingModel, setSimulatingModel] = useState<AdminLogicalModel>();
    const [simulationIntent, setSimulationIntent] = useState<ModelRequestIntent>();
    const [simulationResult, setSimulationResult] = useState<RouteSimulationResult>();
    const [simulating, setSimulating] = useState(false);
    const [modelForm] = Form.useForm<LogicalModelFormValues>();
    const modelCapability = Form.useWatch("capability", modelForm) || "image";
    const modelRoutes = Form.useWatch("routes", modelForm) || [];
    const modelCapabilitySpec = Form.useWatch("capabilitySpec", modelForm);

    const reload = async () => {
        setLoading(true);
        try {
            const [modelResult, firstChannelPage] = await Promise.all([listAdminLogicalModels(), listAdminChannels({ page: 1, limit: 100 })]);
            const remainingChannelPages = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(firstChannelPage.total / firstChannelPage.limit) - 1) }, (_, index) => listAdminChannels({ page: index + 2, limit: firstChannelPage.limit })));
            const channels = [firstChannelPage, ...remainingChannelPages].flatMap((result) => result.channels);
            const channelModelResults = await Promise.all(channels.map((channel) => listAdminChannelModels(channel.id)));
            setModels(modelResult.models);
            setChannelModels(channelModelResults.flatMap((result) => result.models));
            setChannelNames(Object.fromEntries(channels.map((channel) => [channel.id, channel.name])));
            setChannelEnabled(Object.fromEntries(channels.map((channel) => [channel.id, channel.enabled !== false])));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取前台模型配置失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void reload();
    }, []);

    const filteredModels = useMemo(() => models.filter((item) => !deferredKeyword || [item.name, item.code, item.capability].some((value) => value.toLowerCase().includes(deferredKeyword))), [models, deferredKeyword]);
    const paginatedModels = useMemo(() => filteredModels.slice((page - 1) * pageSize, page * pageSize), [filteredModels, page, pageSize]);
    const modelChannelModels = useMemo(() => channelModels.filter((item) => item.capability === modelCapability), [channelModels, modelCapability]);
    const modelSourceSpecs = useMemo(
        () =>
            modelRoutes
                .filter((route) => route.enabled && route.weight > 0)
                .map((route) => channelModels.find((item) => item.id === route.channelModelId && item.enabled && channelEnabled[item.channelId] !== false))
                .map((item) => (item ? capabilitySpecFromChannelModel(item) : undefined))
                .filter((item): item is CapabilitySpec => Boolean(item)),
        [channelEnabled, channelModels, modelRoutes],
    );

    const openModel = (item?: AdminLogicalModel) => {
        const capability = item?.capability || "image";
        modelForm.resetFields();
        modelForm.setFieldsValue(
            item
                ? logicalModelToForm(item)
                : {
                      code: "",
                      name: "",
                      icon: "",
                      description: "",
                      capability,
                      enabled: true,
                      sortOrder: models.length,
                      pricePolicy: "unified",
                      billingMode: "fixed_request",
                      unitPriceMicrocredits: 0,
                      inputPriceMicrocredits: 0,
                      outputPriceMicrocredits: 0,
                      cachedPriceMicrocredits: 0,
                      formula: "",
                      capabilitySpec: emptyCapabilitySpec(capability),
                      defaultOptions: {},
                      routes: [],
                  },
        );
        setEditingModel(item || null);
    };

    const saveModel = async () => {
        const values = await modelForm.validateFields();
        if (values.enabled && !values.routes.length) {
            message.error("请至少添加一条供应线路");
            return;
        }
        const sourceError = capabilitySourceError(values.capability, modelSourceSpecs, values.capabilitySpec);
        if (values.enabled && sourceError) {
            message.error(sourceError);
            return;
        }
        setSaving(true);
        try {
            const payload = logicalModelPayload(values, modelSourceSpecs);
            await (editingModel ? updateAdminLogicalModel(editingModel.id, payload) : createAdminLogicalModel(payload));
            setEditingModel(undefined);
            await reload();
            message.success(editingModel ? "前台模型已更新" : "前台模型已创建");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存前台模型失败");
        } finally {
            setSaving(false);
        }
    };

    const toggleModel = async (item: AdminLogicalModel) => {
        try {
            await updateAdminLogicalModel(item.id, logicalModelPayload({ ...logicalModelToForm(item), enabled: !item.enabled }));
            await reload();
            message.success(item.enabled ? "前台模型已停用" : "前台模型已启用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新模型状态失败");
        }
    };

    const removeModel = async (item: AdminLogicalModel) => {
        setDeletingModelId(item.id);
        try {
            await deleteAdminLogicalModel(item.id);
            setModels((current) => current.filter((model) => model.id !== item.id));
            if (paginatedModels.length === 1 && page > 1) setPage(page - 1);
            message.success("前台模型已归档");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "归档前台模型失败");
            throw error;
        } finally {
            setDeletingModelId(undefined);
        }
    };

    const openSimulation = (item: AdminLogicalModel) => {
        setSimulationIntent({
            capability: item.capability,
            operation: item.capabilitySpec.operations?.[0],
            inputs: Object.fromEntries(Object.entries(item.capabilitySpec.inputs || {}).map(([name, value]) => [name, value.min])),
            options: { ...item.defaultOptions },
        });
        setSimulationResult(undefined);
        setSimulatingModel(item);
    };

    const runSimulation = async () => {
        if (!simulatingModel || !simulationIntent) return;
        setSimulating(true);
        try {
            setSimulationResult(await simulateAdminLogicalModel(simulatingModel.id, simulationIntent));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "路由模拟失败");
        } finally {
            setSimulating(false);
        }
    };

    const modelColumns: ColumnsType<AdminLogicalModel> = [
        {
            title: "前台模型",
            dataIndex: "name",
            render: (_, item) => (
                <div className="flex min-w-0 items-center gap-2">
                    <ModelLogo icon={item.icon} size={20} />
                    <div className="min-w-0">
                        <div className="truncate font-medium">{item.name}</div>
                        <div className="mt-0.5 truncate text-xs text-foreground/45">{item.code}</div>
                    </div>
                </div>
            ),
        },
        { title: "类型", dataIndex: "capability", width: 90, render: (value: CapabilityKind) => capabilityLabel(value) },
        { title: "创作端能力", width: 360, render: (_, item) => <CapabilitySummary spec={item.capabilitySpec} /> },
        {
            title: "供应线路",
            width: 110,
            render: (_, item) => (
                <div className="text-xs">
                    <div>{item.routes.filter((route) => route.enabled && route.available).length} 条可用</div>
                    <div className="text-foreground/45">共 {item.routes.length} 条</div>
                </div>
            ),
        },
        { title: "用户价格", width: 160, render: (_, item) => logicalPriceLabel(item) },
        { title: "状态", width: 130, render: (_, item) => logicalModelStatusTag(item) },
        {
            title: "操作",
            width: 230,
            align: "right",
            render: (_, item) => (
                <AdminRowActions
                    primary={{ label: "编辑", icon: <Pencil className="size-3.5" />, onClick: () => openModel(item) }}
                    visibleActionCount={1}
                    actions={[
                        { key: "simulate", label: "模拟供应线路匹配", icon: <FlaskConical className="size-3.5" />, onClick: () => openSimulation(item) },
                        { key: "toggle", label: item.enabled ? "停用" : "启用", onClick: () => void toggleModel(item) },
                        {
                            key: "archive",
                            label: "归档模型",
                            icon: <Archive className="size-3.5" />,
                            danger: true,
                            disabled: deletingModelId === item.id,
                            confirm: {
                                title: `归档前台模型“${item.name}”？`,
                                description: "归档后模型将从公开目录中移除，不能在页面恢复；历史任务和版本记录会保留。排队中或进行中的任务仍在使用时无法归档。",
                                okText: "确认归档",
                            },
                            onClick: () => removeModel(item),
                        },
                    ]}
                />
            ),
        },
    ];

    return (
        <AdminPageFrame
            title="模型目录"
            actions={
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => openModel()}>
                    新增模型
                </Button>
            }
        >
            <AdminDataTable
                toolbar={
                    <Input
                        prefix={<Search className="size-4 text-foreground/40" />}
                        allowClear
                        value={keyword}
                        onChange={(event) => {
                            setKeyword(event.target.value);
                            setPage(1);
                        }}
                        placeholder="搜索模型名称、代码或能力"
                        className="app-list-search"
                    />
                }
                toolbarActiveFilters={
                    keyword ? (
                        <AdminFilterChip
                            label={`搜索：${keyword}`}
                            onRemove={() => {
                                setKeyword("");
                                setPage(1);
                            }}
                        />
                    ) : null
                }
                toolbarActive={Boolean(keyword)}
                onReset={() => {
                    setKeyword("");
                    setPage(1);
                }}
                table={{ className: "admin-logical-model-table", rowKey: "id", size: "small", loading, pagination: false, columns: modelColumns, dataSource: paginatedModels, scroll: { x: 980 } }}
                empty={<AdminTableEmpty filtered={Boolean(deferredKeyword)} title="暂无模型" />}
                footer={
                    <PaginationBar
                        alwaysShow
                        current={page}
                        pageSize={pageSize}
                        total={filteredModels.length}
                        onChange={(nextPage, nextPageSize) => {
                            setPage(nextPageSize !== pageSize ? 1 : nextPage);
                            setPageSize(nextPageSize);
                        }}
                    />
                }
            />

            <Drawer
                title={editingModel ? "编辑前台模型" : "新增前台模型"}
                open={editingModel !== undefined}
                size="min(1120px, 100vw)"
                destroyOnHidden
                maskClosable={!saving}
                onClose={() => !saving && setEditingModel(undefined)}
                rootClassName="admin-drawer"
                footer={
                    <div className="flex justify-end gap-2">
                        <Button disabled={saving} onClick={() => setEditingModel(undefined)}>
                            取消
                        </Button>
                        <Button type="primary" loading={saving} onClick={() => void saveModel()}>
                            保存
                        </Button>
                    </div>
                }
            >
                <Form
                    form={modelForm}
                    layout="vertical"
                    requiredMark={false}
                    className="space-y-3"
                    onValuesChange={(changedValues: Partial<LogicalModelFormValues>) => {
                        const capability = changedValues.capability;
                        if (!capability) return;
                        modelForm.setFieldsValue({
                            routes: [],
                            capabilitySpec: emptyCapabilitySpec(capability),
                            defaultOptions: {},
                            billingMode: capability === "text" ? "token" : capability === "video" ? "per_second" : "fixed_request",
                        });
                    }}
                >
                    {editingModel?.configurationError || editingModel?.availabilityError ? (
                        <Alert
                            className="mb-4"
                            type="warning"
                            showIcon
                            message={editingModel.configurationError ? "当前供应线路无法覆盖全部创作端能力" : "当前供应线路暂不可结算"}
                            description={editingModel.configurationError || editingModel.availabilityError}
                        />
                    ) : null}
                    <DrawerSection icon={<Layers3 className="size-4" />} title="前台展示">
                        <div className="grid gap-3 sm:grid-cols-3">
                            <Form.Item name="name" label="显示名称" rules={[{ required: true, message: "请填写显示名称" }]}>
                                <Input placeholder="例如：Seedance 视频" />
                            </Form.Item>
                            <Form.Item name="code" label="模型代码" rules={[{ required: true, message: "请填写模型代码" }]}>
                                <Input placeholder="例如：seedance-video" />
                            </Form.Item>
                            <Form.Item name="icon" label="模型 Logo">
                                <ModelIconPicker />
                            </Form.Item>
                        </div>
                        <Form.Item name="description" label="简短说明">
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="说明适合的创作场景，不描述供应渠道。" />
                        </Form.Item>
                        <Form.Item name="capability" label="类型">
                            <CapabilityCardPicker density="compact" />
                        </Form.Item>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Form.Item name="sortOrder" label="前台排序">
                                <InputNumber className="w-full" precision={0} />
                            </Form.Item>
                            <Form.Item name="enabled" label="启用" valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </div>
                    </DrawerSection>
                    <DrawerSection icon={<GitBranch className="size-4" />} title="供应线路">
                        <RouteFields channelModels={modelChannelModels} channelNames={channelNames} channelEnabled={channelEnabled} form={modelForm} capability={modelCapability} />
                    </DrawerSection>
                    <DrawerSection title="创作端可选能力">
                        <Form.Item name="capabilitySpec" noStyle>
                            <CapabilityScopeEditor capability={modelCapability} sourceSpecs={modelSourceSpecs} mode="front" />
                        </Form.Item>
                    </DrawerSection>
                    <DrawerSection title="默认参数">
                        <Form.Item name="defaultOptions" noStyle>
                            <DefaultOptionsEditor spec={modelCapabilitySpec} />
                        </Form.Item>
                    </DrawerSection>
                    <section className="admin-form-section">
                        <div className="mb-4">
                            <h2 className="text-sm font-semibold">用户价格</h2>
                        </div>
                        <PricingFields channelModels={channelModels} />
                    </section>
                </Form>
            </Drawer>

            <Modal
                title={simulatingModel ? `供应线路匹配模拟 - ${simulatingModel.name}` : "供应线路匹配模拟"}
                open={Boolean(simulatingModel)}
                className="workspace-modal workspace-modal-wide admin-simulation-modal"
                rootClassName="admin-modal-root"
                centered
                destroyOnHidden
                onCancel={() => setSimulatingModel(undefined)}
                styles={{ body: { maxHeight: "min(72vh, 720px)", overflowY: "auto" } }}
                footer={[
                    <Button key="cancel" onClick={() => setSimulatingModel(undefined)}>
                        关闭
                    </Button>,
                    <Button key="submit" type="primary" icon={<FlaskConical className="size-4" />} loading={simulating} onClick={() => void runSimulation()}>
                        模拟匹配
                    </Button>,
                ]}
            >
                {simulatingModel && simulationIntent ? (
                    <div className="space-y-5">
                        {simulatingModel.capabilitySpec.operations?.length ? (
                            <label className="block">
                                <span className="mb-1 block text-xs text-foreground/55">生成方式</span>
                                <Select
                                    className="w-full"
                                    value={simulationIntent.operation}
                                    options={simulatingModel.capabilitySpec.operations.map((value) => ({ value, label: operationLabel(value) }))}
                                    onChange={(operation) => setSimulationIntent({ ...simulationIntent, operation })}
                                />
                            </label>
                        ) : null}
                        <CapabilityRequestEditor
                            spec={simulatingModel.capabilitySpec}
                            inputs={simulationIntent.inputs || {}}
                            options={simulationIntent.options || {}}
                            onInputsChange={(inputs) => setSimulationIntent({ ...simulationIntent, inputs })}
                            onOptionsChange={(options) => setSimulationIntent({ ...simulationIntent, options })}
                        />
                        {simulationResult ? (
                            <section className="pt-1">
                                <div className="mb-3 flex items-center justify-between">
                                    <h2 className="text-sm font-semibold">匹配结果</h2>
                                    <Tag variant="filled" color={simulationResult.productMatch.matched ? "success" : "error"}>
                                        {simulationResult.productMatch.matched ? "请求能力通过" : "请求能力不匹配"}
                                    </Tag>
                                </div>
                                {simulationResult.productMatch.reasons?.length ? <p className="mb-4 text-sm text-error">{simulationResult.productMatch.reasons.join("；")}</p> : null}
                                <Table size="small" pagination={false} rowKey="routeId" dataSource={simulationResult.candidates} columns={simulationColumns()} />
                            </section>
                        ) : null}
                    </div>
                ) : null}
            </Modal>
        </AdminPageFrame>
    );
}

function DrawerSection({ icon, title, description, children }: { icon?: ReactNode; title: string; description?: string; children: ReactNode }) {
    return (
        <section className="rounded-lg bg-muted/20 p-4">
            <div className="mb-4 flex items-center gap-2.5">
                {icon ? <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50 text-foreground/55">{icon}</span> : null}
                <div>
                    <h2 className="text-[var(--fs-body)] font-semibold">{title}</h2>
                    {description ? <p className="mt-1 text-xs leading-5 text-foreground/50">{description}</p> : null}
                </div>
            </div>
            {children}
        </section>
    );
}

function RouteFields({
    channelModels,
    channelNames,
    channelEnabled,
    form,
    capability,
}: {
    channelModels: ChannelModel[];
    channelNames: Record<string, string>;
    channelEnabled: Record<string, boolean>;
    form: FormInstance<LogicalModelFormValues>;
    capability: CapabilityKind;
}) {
    const selectOptions = channelModels.map((item) => {
        const unavailableReason = channelEnabled[item.channelId] === false ? "渠道已停用" : !item.enabled ? "渠道模型已停用" : "";
        return {
            value: item.id,
            label: `${channelNames[item.channelId]} / ${item.displayName || item.modelKey}${unavailableReason ? `（${unavailableReason}）` : ""}`,
            disabled: Boolean(unavailableReason),
        };
    });
    const availableChannelModelCount = selectOptions.filter((item) => !item.disabled).length;
    return (
        <Form.List name="routes">
            {(fields, { add, remove }) => {
                const currentRoutes = (form.getFieldValue("routes") || []) as RouteRuleRow[];
                const selectedChannelModelCount = new Set(currentRoutes.map((route) => route?.channelModelId).filter(Boolean)).size;
                const canAdd = selectedChannelModelCount < availableChannelModelCount;
                return (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-foreground/50">共 {fields.length} 条供应线路</span>
                            <Button size="small" icon={<Plus className="size-3.5" />} disabled={!canAdd} onClick={() => add({ channelModelId: "", enabled: true, priority: 100, weight: 100 })}>
                                添加供应线路
                            </Button>
                        </div>
                        {fields.length ? (
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {fields.map((field) => {
                                    const routes = (form.getFieldValue("routes") || []) as RouteRuleRow[];
                                    const selectedByOthers = new Set(routes.map((route, index) => (index === field.name ? "" : route?.channelModelId)).filter(Boolean));
                                    const options = selectOptions.map((option) => ({ ...option, disabled: option.disabled || selectedByOthers.has(option.value) }));
                                    const selected = channelModels.find((item) => item.id === routes[field.name]?.channelModelId);
                                    return (
                                        <div key={field.key} className="rounded-lg border border-border bg-muted/5 p-4">
                                            <div className="mb-2 flex items-center justify-between gap-2">
                                                <div className="min-w-0">
                                                    <div className="text-xs font-semibold">供应线路 {fields.indexOf(field) + 1}</div>
                                                    <div className="mt-0.5 truncate text-xs text-foreground/50">{selected ? `${channelNames[selected.channelId]} / ${selected.displayName || selected.modelKey}` : "选择一个可承接请求的渠道模型"}</div>
                                                </div>
                                                <Button type="text" size="small" danger onClick={() => remove(field.name)}>
                                                    移除
                                                </Button>
                                            </div>
                                            <Form.Item name={[field.name, "channelModelId"]} rules={[{ required: true, message: "请选择渠道模型" }]} className="mb-3">
                                                <Select
                                                    aria-label={`供应线路 ${fields.indexOf(field) + 1}`}
                                                    showSearch
                                                    optionFilterProp="label"
                                                    placeholder="选择渠道模型"
                                                    options={options}
                                                    onChange={(channelModelId) => {
                                                        const nextRoutes = [...(form.getFieldValue("routes") || [])];
                                                        nextRoutes[field.name] = { ...nextRoutes[field.name], channelModelId };
                                                        const specs = nextRoutes
                                                            .filter((route) => route.enabled && route.weight > 0)
                                                            .map((route) => channelModels.find((item) => item.id === route.channelModelId && item.enabled && channelEnabled[item.channelId] !== false))
                                                            .map((item) => (item ? capabilitySpecFromChannelModel(item) : undefined))
                                                            .filter((item): item is CapabilitySpec => Boolean(item));
                                                        form.setFieldValue("routes", nextRoutes);
                                                        if (!hasCapabilityRules(form.getFieldValue("capabilitySpec"))) form.setFieldValue("capabilitySpec", mergeCapabilitySpecs(capability, specs));
                                                    }}
                                                />
                                            </Form.Item>
                                            <div className="flex items-end gap-2">
                                                <Form.Item name={[field.name, "priority"]} label="优先级" className="mb-0 min-w-0 flex-1">
                                                    <InputNumber className="w-full" precision={0} />
                                                </Form.Item>
                                                <Form.Item name={[field.name, "weight"]} label="权重" className="mb-0 min-w-0 flex-1">
                                                    <InputNumber className="w-full" min={0} precision={0} />
                                                </Form.Item>
                                                <Form.Item name={[field.name, "enabled"]} label="启用" valuePropName="checked" className="mb-0 shrink-0">
                                                    <Switch />
                                                </Form.Item>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                        {!fields.length ? <div className="rounded-md bg-muted/20 px-3 py-4 text-center text-xs text-foreground/50">尚未添加供应线路</div> : null}
                    </div>
                );
            }}
        </Form.List>
    );
}

function logicalModelStatusTag(item: AdminLogicalModel) {
    if (!item.enabled) return <AdminStatusBadge label="已停用" tone="neutral" />;
    if (item.configurationError) return <AdminStatusBadge label="能力配置需调整" tone="warning" title={item.configurationError} />;
    if (item.availabilityError) return <AdminStatusBadge label="线路价格需调整" tone="warning" title={item.availabilityError} />;
    if (!item.available) return <AdminStatusBadge label="暂无可用线路" tone="warning" />;
    return <AdminStatusBadge label="可用" tone="success" />;
}

function PricingFields({ channelModels }: { channelModels: ChannelModel[] }) {
    const form = Form.useFormInstance<LogicalModelFormValues>();
    const formulaTextareaRef = useRef<HTMLTextAreaElement>(null);
    const pricePolicy = Form.useWatch("pricePolicy") as LogicalModelMutation["pricePolicy"] | undefined;
    const billingMode = Form.useWatch("billingMode") as LogicalModelMutation["billingMode"] | undefined;
    const capability = Form.useWatch("capability") as CapabilityKind | undefined;
    const routes = (Form.useWatch("routes") || []) as RouteRuleRow[];
    const enabledRoutes = routes.filter((route) => route.enabled);
    const tokenBillingSupported =
        capability === "text" ||
        (capability === "video" &&
            enabledRoutes.length > 0 &&
            enabledRoutes.every((route) => {
                const channelModel = channelModels.find((item) => item.id === route.channelModelId);
                return modelProtocolSupportsTokenBilling(channelModel?.capability, channelModel?.protocol);
            }));
    const modes: Array<{ label: string; value: LogicalModelMutation["billingMode"]; disabled?: boolean }> = [
        { label: "按次计费", value: "fixed_request" },
        { label: "按秒计费", value: "per_second", disabled: capability !== "video" },
        { label: "Token 计费", value: "token", disabled: !tokenBillingSupported },
        { label: "公式计费", value: "formula" },
    ];

    useEffect(() => {
        if (pricePolicy === "unified" && billingMode === "token" && !tokenBillingSupported) {
            form.setFieldValue("billingMode", capability === "video" ? "per_second" : "fixed_request");
        }
    }, [billingMode, capability, form, pricePolicy, tokenBillingSupported]);

    const handleBillingModeChange = (value: string | number) => {
        const mode = value as LogicalModelMutation["billingMode"];
        if (mode !== "formula") form.setFieldValue("formula", "");
        if (mode !== "token") {
            form.setFieldsValue({ inputPriceMicrocredits: 0, outputPriceMicrocredits: 0, cachedPriceMicrocredits: 0 });
        }
        if (mode !== "fixed_request" && mode !== "per_second") form.setFieldValue("unitPriceMicrocredits", 0);
    };

    const changePolicy = (value: string | number) => {
        const nextPolicy = value as LogicalModelMutation["pricePolicy"];
        if (nextPolicy !== "unified") return;
        const supportedModes = modes.filter((item) => !item.disabled).map((item) => item.value);
        if (!billingMode || !supportedModes.includes(billingMode)) {
            form.setFieldValue("billingMode", capability === "text" ? "token" : capability === "video" ? "per_second" : "fixed_request");
        }
    };
    return (
        <>
            <Form.Item name="pricePolicy" label="定价策略">
                <Segmented
                    block
                    options={[
                        { label: "跟随供应价格", value: "channel" },
                        { label: "统一定价", value: "unified" },
                    ]}
                    onChange={changePolicy}
                />
            </Form.Item>
            {pricePolicy === "unified" ? (
                <>
                    <Form.Item name="billingMode" label="计费方式">
                        <Segmented block options={modes} onChange={handleBillingModeChange} />
                    </Form.Item>
                    {billingMode !== "token" && billingMode !== "formula" ? (
                        <Form.Item name="unitPriceMicrocredits" label={billingMode === "per_second" ? "每秒消耗积分" : "每次消耗积分"}>
                            <CreditsInput />
                        </Form.Item>
                    ) : null}
                    {capability === "video" && !tokenBillingSupported ? <div className="mb-3 text-xs leading-5 text-foreground/50">Token 计费仅在所有启用供应线路都使用火山方舟视频协议时可用。</div> : null}
                    {billingMode === "token" ? (
                        capability === "video" ? (
                            <Form.Item name="outputPriceMicrocredits" label="视频 / 百万 Token" rules={[{ type: "number", min: 1, message: "请输入视频 Token 价格" }]}>
                                <CreditsInput />
                            </Form.Item>
                        ) : (
                            <div className="grid gap-3 sm:grid-cols-3">
                                <Form.Item name="inputPriceMicrocredits" label="输入 / 百万 Token">
                                    <CreditsInput />
                                </Form.Item>
                                <Form.Item name="outputPriceMicrocredits" label="输出 / 百万 Token">
                                    <CreditsInput />
                                </Form.Item>
                                <Form.Item name="cachedPriceMicrocredits" label="缓存 / 百万 Token">
                                    <CreditsInput />
                                </Form.Item>
                            </div>
                        )
                    ) : null}
                    {billingMode === "formula" ? <FormulaBillingFields textareaRef={formulaTextareaRef} /> : null}
                </>
            ) : (
                <div className="rounded-md bg-muted/20 px-3 py-3 text-xs leading-5 text-foreground/55">用户费用按实际命中的供应线路价格计算。故障切换到更高价格线路时会重新校验余额。</div>
            )}
        </>
    );
}

const formulaSnippetGroups = [
    {
        title: "请求体",
        items: [
            { label: "duration", snippet: "body.duration", tip: "视频时长（秒）" },
            { label: "seconds", snippet: "body.seconds", tip: "视频时长（秒）" },
            { label: "resolution", snippet: "body.resolution", tip: "视频分辨率，如 480p、720p、1080p" },
            { label: "width", snippet: "body.width", tip: "图片或视频宽度" },
            { label: "height", snippet: "body.height", tip: "图片或视频高度" },
            { label: "size", snippet: "body.size", tip: "图片或视频尺寸" },
            { label: "quality", snippet: "body.quality", tip: "质量参数" },
            { label: "n", snippet: "body.n", tip: "生成数量" },
            { label: "model", snippet: "body.model", tip: "模型名称" },
            { label: "max_tokens", snippet: "body.max_tokens", tip: "最大输出 Token 数" },
            { label: "temperature", snippet: "body.temperature", tip: "温度参数" },
        ],
    },
    {
        title: "运算",
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
            { label: "?:", snippet: " ?  : ", tip: "条件 ? 真值 : 假值" },
            { label: "in", snippet: " in ", tip: '值 in ["a", "b"]' },
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

function FormulaBillingFields({ textareaRef }: { textareaRef: RefObject<HTMLTextAreaElement | null> }) {
    const insertSnippet = (snippet: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        const nextValue = textarea.value.slice(0, start) + snippet + textarea.value.slice(end);
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        nativeSetter?.call(textarea, nextValue);
        const cursorOffset = snippet.includes("()") ? snippet.indexOf(")") : snippet.includes("(, )") ? snippet.indexOf(", ") + 2 : snippet.length;
        textarea.selectionStart = textarea.selectionEnd = start + cursorOffset;
        textarea.focus();
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };

    return (
        <div className="space-y-2">
            <div className="text-xs text-foreground/50">点击下方常量可插入到公式中</div>
            <div className="space-y-1.5">
                {formulaSnippetGroups.map((group) => (
                    <div key={group.title} className="flex flex-wrap items-center gap-1">
                        <span className="mr-1 text-[var(--fs-micro)] font-medium text-foreground/40">{group.title}</span>
                        {group.items.map((item) => (
                            <Tooltip key={item.label} title={item.tip || item.snippet} mouseEnterDelay={0.4}>
                                <Tag className="cursor-pointer !m-0 !px-1.5 !text-[var(--fs-micro)] !font-mono !leading-5 transition-colors hover:!bg-primary/10 hover:!text-primary hover:!border-primary/30" onClick={() => insertSnippet(item.snippet)}>
                                    {item.label}
                                </Tag>
                            </Tooltip>
                        ))}
                    </div>
                ))}
            </div>
            <Form.Item name="formula" label="计算公式" rules={[{ required: true, whitespace: true, message: "请输入计算公式" }]}>
                <Input.TextArea
                    ref={(node) => {
                        const native = node?.nativeElement;
                        if (native instanceof HTMLTextAreaElement) textareaRef.current = native;
                    }}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder="例如：body.duration * 0.5"
                />
            </Form.Item>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-foreground/55">
                <div className="mb-1 font-medium text-foreground/70">公式语法说明</div>
                <div>• <code className="text-foreground/80">body.xxx</code> 访问生成参数</div>
                <div>• 算术: <code>+ - * /</code> &nbsp; 比较: <code>&gt; &lt; &gt;= &lt;= == !=</code> &nbsp; 逻辑: <code>&& || !</code></div>
                <div>• 条件: <code>条件 ? 真值 : 假值</code>（可嵌套实现多档） &nbsp; 成员: <code>in ["a","b"]</code></div>
                <div>• 函数: <code>ceil floor round abs max min len</code></div>
                <div>• 多档示例: <code>body.duration &gt; 30 ? 3.0 : (body.duration &gt; 10 ? 2.0 : 1.0)</code></div>
                <div>• 公式结果单位为积分，如 <code>body.duration * 0.5</code> 表示每秒 0.5 积分</div>
            </div>
        </div>
    );
}

function CreditsInput({ value = 0, onChange }: { value?: number; onChange?: (value: number) => void }) {
    return <InputNumber className="w-full" min={0} max={1_000_000} precision={6} step={0.1} value={value / 1_000_000} onChange={(next) => onChange?.(Math.round((next || 0) * 1_000_000))} />;
}

function logicalPriceLabel(item: AdminLogicalModel) {
    if (item.pricePolicy === "channel") return <span className="text-xs">跟随供应价格</span>;
    if (item.billingMode === "formula") return <span className="text-xs">公式计费</span>;
    if (item.billingMode === "token" && item.capability === "video") return <span className="text-xs">视频 {formatCredits(item.outputPriceMicrocredits)} / 百万 Token</span>;
    if (item.billingMode === "token")
        return (
            <div className="text-xs">
                <div>输入 {formatCredits(item.inputPriceMicrocredits)} / 百万</div>
                <div>输出 {formatCredits(item.outputPriceMicrocredits)} / 百万</div>
                <div className="text-foreground/45">缓存 {formatCredits(item.cachedPriceMicrocredits)} / 百万</div>
            </div>
        );
    return (
        <span className="text-xs">
            {formatCredits(item.unitPriceMicrocredits)} / {item.billingMode === "per_second" ? "秒" : "次"}
        </span>
    );
}

function logicalModelToForm(item: AdminLogicalModel): LogicalModelFormValues {
    return {
        code: item.code,
        name: item.name,
        icon: item.icon || "",
        description: item.description,
        capability: item.capability,
        enabled: item.enabled,
        sortOrder: item.sortOrder,
        pricePolicy: item.pricePolicy,
        billingMode: item.billingMode,
        unitPriceMicrocredits: item.unitPriceMicrocredits,
        inputPriceMicrocredits: item.inputPriceMicrocredits,
        outputPriceMicrocredits: item.outputPriceMicrocredits,
        cachedPriceMicrocredits: item.cachedPriceMicrocredits,
        formula: item.formulaConfig?.formula || "",
        capabilitySpec: item.capabilitySpec,
        defaultOptions: item.defaultOptions,
        routes: item.routes.map((route) => ({ channelModelId: route.channelModelId, enabled: route.enabled, priority: route.priority, weight: route.weight })),
    };
}

function logicalModelPayload(values: LogicalModelFormValues, sourceSpecs: CapabilitySpec[] = []): LogicalModelMutation {
    const capabilitySpec = normalizeCapabilitySpecForSources({ ...values.capabilitySpec, capability: values.capability, version: 1 as const }, sourceSpecs) || emptyCapabilitySpec(values.capability);
    return {
        code: values.code.trim(),
        name: values.name.trim(),
        icon: values.icon.trim(),
        description: values.description?.trim() || "",
        capability: values.capability,
        enabled: values.enabled,
        sortOrder: values.sortOrder || 0,
        pricePolicy: values.pricePolicy,
        billingMode: values.billingMode,
        unitPriceMicrocredits: values.unitPriceMicrocredits || 0,
        inputPriceMicrocredits: values.inputPriceMicrocredits || 0,
        outputPriceMicrocredits: values.outputPriceMicrocredits || 0,
        cachedPriceMicrocredits: values.cachedPriceMicrocredits || 0,
        formulaConfig: values.billingMode === "formula" ? { formula: values.formula.trim() } : undefined,
        capabilitySpec,
        defaultOptions: sanitizeDefaults(capabilitySpec, values.defaultOptions),
        routes: values.routes.map((route) => ({ ...route, priority: route.priority || 0, weight: route.weight || 0 })),
    };
}

function hasCapabilityRules(spec?: CapabilitySpec) {
    return Boolean(spec && ((spec.operations?.length || 0) > 0 || Object.keys(spec.inputs || {}).length > 0 || Object.keys(spec.options || {}).length > 0));
}

function simulationColumns(): ColumnsType<RouteSimulationResult["candidates"][number]> {
    return [
        {
            title: "供应线路",
            render: (_, candidate) => `${candidate.channelModelName}（${candidate.channelModelKey}）`,
        },
        { title: "优先级", dataIndex: "priority", width: 80 },
        { title: "权重", dataIndex: "weight", width: 70 },
        {
            title: "结果",
            width: 110,
            render: (_, candidate) => (
                <Tag variant="filled" color={candidate.inPool ? "success" : candidate.blocked ? "warning" : "default"}>
                    {candidate.inPool ? "进入候选池" : candidate.blocked ? "冷却中" : candidate.matched ? "低优先级" : "不匹配"}
                </Tag>
            ),
        },
        { title: "原因", render: (_, candidate) => candidate.reasons?.join("；") || "-" },
    ];
}
