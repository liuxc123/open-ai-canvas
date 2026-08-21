import { App, Button, Form, Input, Segmented, Space } from "antd";
import { Cloud, Globe, HardDrive, Info, KeyRound, LocateFixed, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getAdminOSSSetting, testAdminOSSSetting, updateAdminOSSSetting, type AdminOSSSetting } from "@/services/api/auth";
import type { StorageProvider } from "@/services/api/resources";
import { useAdminContext } from "../admin-context";
import { AdminPageFrame } from "../components/admin-shell";
import { AdminStatusBadge, configuredSecretText, SettingsSectionCard } from "../components/admin-ui";

type StorageMode = "local" | StorageProvider;
type OSSFormValues = {
    mode: StorageMode;
    publicBaseUrl?: string;
    region?: string;
    endpoint?: string;
    cdnBaseUrl?: string;
    bucket?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    pathPrefix?: string;
};

const providerLabels: Record<StorageProvider, string> = {
    aliyun: "阿里云 OSS",
    tencent: "腾讯云 COS",
    s3: "Amazon S3",
    qiniu: "七牛云 Kodo",
};

const providerPlaceholders: Record<StorageProvider, { region: string; endpoint: string; accessKeyId: string; accessKeySecret: string }> = {
    aliyun: { region: "oss-cn-hangzhou", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", accessKeyId: "阿里云 AccessKey ID", accessKeySecret: "阿里云 AccessKey Secret" },
    tencent: { region: "ap-guangzhou", endpoint: "https://cos.ap-guangzhou.myqcloud.com", accessKeyId: "腾讯云 SecretId", accessKeySecret: "腾讯云 SecretKey" },
    s3: { region: "us-east-1", endpoint: "https://s3.us-east-1.amazonaws.com", accessKeyId: "AWS Access Key ID", accessKeySecret: "AWS Secret Access Key" },
    qiniu: { region: "z0 / cn-east-1", endpoint: "https://up-z0.qiniup.com", accessKeyId: "七牛云 AccessKey", accessKeySecret: "七牛云 SecretKey" },
};

export default function StorageSettingsPage() {
    const { message } = App.useApp();
    const { references } = useAdminContext();
    const [setting, setSetting] = useState<AdminOSSSetting | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [form] = Form.useForm<OSSFormValues>();
    const mode = Form.useWatch("mode", form) || "local";
    const cdnBaseUrl = Form.useWatch("cdnBaseUrl", form);
    const isObjectStorage = mode !== "local";
    const isTencentCOS = mode === "tencent";
    const isQiniuKodo = mode === "qiniu";
    const accessKeyIdLabel = isTencentCOS ? "SecretId" : isQiniuKodo ? "AccessKey" : "AccessKey ID";
    const accessKeySecretLabel = isTencentCOS ? "SecretKey" : isQiniuKodo ? "SecretKey" : "AccessKey Secret";
    const hasCurrentProviderSecret = Boolean(setting && setting.provider === mode && setting.hasAccessKeySecret);
    const userNameById = useMemo(() => new Map(references.users.map((user) => [user.id, user.displayName || user.username])), [references.users]);
    const prevModeRef = useRef<StorageMode>(mode);
    const cloudDraftsRef = useRef<Partial<Record<StorageProvider, Partial<OSSFormValues>>>>({});
    const hasSavedSecret = setting?.enabled && setting.provider === mode && setting.hasAccessKeySecret;

    useEffect(() => {
        const prev = prevModeRef.current;
        if (prev !== "local" && mode !== "local" && prev !== mode) {
            const all = form.getFieldsValue(true);
            cloudDraftsRef.current[prev as StorageProvider] = {
                region: all.region, endpoint: all.endpoint, bucket: all.bucket,
                accessKeyId: all.accessKeyId, accessKeySecret: all.accessKeySecret,
                pathPrefix: all.pathPrefix, publicBaseUrl: all.publicBaseUrl,
            };
            const cached = cloudDraftsRef.current[mode as StorageProvider];
            form.setFieldsValue({
                region: "", endpoint: "", bucket: "", accessKeyId: "",
                accessKeySecret: "", pathPrefix: "", publicBaseUrl: "",
                ...cached,
            });
        }
        prevModeRef.current = mode;
    }, [mode, form]);

    useEffect(() => {
        void getAdminOSSSetting()
            .then(({ setting: value }) => {
                setSetting(value);
                form.setFieldsValue(formValues(value));
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "读取对象存储配置失败"))
            .finally(() => setLoading(false));
    }, [form, message]);

    const test = async () => {
        const values = form.getFieldsValue(true);
        const isCloud = values.mode !== "local";
        if (!isCloud) return;
        if (!values.bucket?.trim()) return message.error("请填写 Bucket");
        if (!values.endpoint?.trim()) return message.error("请填写 Endpoint");
        if (!values.accessKeyId?.trim()) return message.error(`请填写 ${accessKeyIdLabel}`);
        if (!values.accessKeySecret?.trim() && !hasSavedSecret) return message.error(`请填写 ${accessKeySecretLabel}`);
        if ((values.mode === "tencent" || values.mode === "s3") && !values.region?.trim()) return message.error("请填写 Region");
        setTesting(true);
        try {
            const provider = values.mode as StorageProvider;
            await testAdminOSSSetting({
                enabled: true,
                provider,
                region: values.region?.trim() || "",
                endpoint: values.endpoint?.trim() || "",
                bucket: values.bucket?.trim() || "",
                accessKeyId: values.accessKeyId?.trim() || "",
                accessKeySecret: values.accessKeySecret?.trim() || "",
                publicBaseUrl: values.publicBaseUrl?.trim() || "",
                pathPrefix: values.pathPrefix?.trim() || "",
            });
            message.success("连接测试成功，存储配置可用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "连接测试失败");
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        await form.validateFields();
        // 本地模式会卸载对象存储字段，读取完整 store 才能保留已保存的配置。
        const values = form.getFieldsValue(true);
        if (values.mode === "local" && !values.publicBaseUrl?.trim()) return message.error("请填写服务器访问地址");
        if (values.mode !== "local" && !values.accessKeySecret?.trim() && !hasCurrentProviderSecret) return message.error(`请填写 ${accessKeySecretLabel}`);
        if (values.mode === "aliyun" && !values.endpoint?.trim()) return message.error("请填写阿里云 OSS Endpoint");
        if (values.mode === "tencent" && !values.endpoint?.trim() && !values.region?.trim()) return message.error("请填写腾讯云 COS Region 或 Endpoint");
        if (values.mode === "s3" && !values.region?.trim()) return message.error("请填写 Amazon S3 Region");
        if (values.mode === "s3" && !values.endpoint?.trim()) return message.error("请填写 Amazon S3 Endpoint");
        if (values.mode === "qiniu" && !values.endpoint?.trim()) return message.error("请填写七牛云 Kodo 上传 Endpoint");
        if (values.mode !== "local" && !values.bucket?.trim()) return message.error("请填写对象存储 Bucket");
        if (values.mode !== "local" && !values.accessKeyId?.trim()) return message.error(`请填写 ${accessKeyIdLabel}`);

        setSaving(true);
        try {
            const result = await updateAdminOSSSetting({
                enabled: values.mode !== "local",
                provider: values.mode === "local" ? setting?.provider || "aliyun" : values.mode,
                region: values.region?.trim() || "",
                endpoint: values.endpoint?.trim() || "",
                cdnBaseUrl: values.cdnBaseUrl?.trim() || "",
                bucket: values.bucket?.trim() || "",
                accessKeyId: values.accessKeyId?.trim() || "",
                accessKeySecret: values.accessKeySecret?.trim() || "",
                publicBaseUrl: values.publicBaseUrl?.trim() || "",
                pathPrefix: values.pathPrefix?.trim() || "",
            });
            setSetting(result.setting);
            form.setFieldsValue(formValues(result.setting));
            message.success("存储配置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存存储配置失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <AdminPageFrame title="存储服务" description="配置新增资源的默认存储位置" scroll>
            <div className="space-y-4 pt-4">
                <div className="border-b border-border px-1 pb-4 text-foreground/75">
                    <div className="flex items-start gap-3"><span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-muted/60"><Info className="size-4" /></span><div><div className="text-sm font-semibold text-foreground">资源存储规则</div><p className="mt-1 text-xs leading-6 text-foreground/55">存储类型只影响之后新增的媒体资源，不迁移或改写历史文件。日常读取继续校验登录态，仅在模型必须通过 URL 拉取本地素材时生成短时签名链接。</p></div></div>
                </div>
                <SettingsSectionCard
                    layout="stacked"
                    contentClassName="px-4 pb-4"
                    icon={<Cloud className="size-4" />}
                    title="平台存储"
                    description="选择平台新增媒体资源的默认写入方式。"
                    status={
                        <Space size={6}>
                            <AdminStatusBadge label={setting?.enabled ? storageProviderLabel(setting.provider) : "服务器本地"} tone="neutral" />
                            {setting?.enabled ? <AdminStatusBadge label={setting.hasAccessKeySecret ? configuredSecretText : "未保存密钥"} tone={setting.hasAccessKeySecret ? "success" : "warning"} /> : null}
                        </Space>
                    }
                    footer={
                        <>
                            <div className="text-xs text-foreground/45">
                                {setting?.updatedAt ? `上次更新：${formatTime(setting.updatedAt)}${setting.updatedBy ? ` · ${userNameById.get(setting.updatedBy) || setting.updatedBy}` : ""}` : "尚未保存平台存储配置"}
                            </div>
                            <div className="flex items-center gap-2">
                                {mode !== "local" ? <Button icon={<Zap className="size-4" />} loading={testing} onClick={() => void test()}>测试连接</Button> : null}
                                <Button type="primary" loading={saving} onClick={() => void save()}>保存存储配置</Button>
                            </div>
                        </>
                    }
                >
                    <Form form={form} layout="vertical" requiredMark={false} disabled={loading} className="px-5 pb-2">
                        <Form.Item name="mode" label="存储类型" rules={[{ required: true, message: "请选择存储类型" }]}>
                            <Segmented<StorageMode>
                                block
                                options={[
                                    { label: <span className="inline-flex items-center gap-2"><HardDrive className="size-4" />服务器本地</span>, value: "local" },
                                    { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />阿里云 OSS</span>, value: "aliyun" },
                                    { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />腾讯云 COS</span>, value: "tencent" },
                                    { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />七牛云 Kodo</span>, value: "qiniu" },
                                    { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />Amazon S3</span>, value: "s3" },
                                ]}
                                onChange={(value) => {
                                    const nextMode = value as StorageMode;
                                    const switchingProvider = nextMode !== "local" && ((mode !== "local" && mode !== nextMode) || (mode === "local" && setting?.provider !== nextMode));
                                    if (switchingProvider) form.setFieldsValue({ region: "", endpoint: "", cdnBaseUrl: "", bucket: "", accessKeyId: "", accessKeySecret: "" });
                                }}
                            />
                        </Form.Item>

                        {isObjectStorage ? (
                            <div className="space-y-1">
                                <div className="grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
                                    <Form.Item name="region" label="Region">
                                        <Input autoComplete="off" placeholder={isTencentCOS ? "例如：ap-guangzhou" : isQiniuKodo ? "例如：z0 / cn-east-1" : "例如：oss-cn-hangzhou"} />
                                    </Form.Item>
                                    <Form.Item name="bucket" label="Bucket">
                                        <Input autoComplete="off" placeholder={isQiniuKodo ? "七牛云存储空间名称" : "对象存储 Bucket"} />
                                    </Form.Item>
                                    <Form.Item name="pathPrefix" label="路径前缀">
                                        <Input autoComplete="off" placeholder="可选，例如：canvas" />
                                    </Form.Item>
                                </div>
                                <div className="grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
                                    <Form.Item className="xl:col-span-2" name="endpoint" label={isQiniuKodo ? "上传 Endpoint" : "Endpoint"} extra={isTencentCOS ? "可留空，系统会根据 Region 生成标准 COS Endpoint。" : undefined}>
                                        <Input autoComplete="off" inputMode="url" placeholder={isTencentCOS ? "https://cos.ap-guangzhou.myqcloud.com" : isQiniuKodo ? "https://up-z0.qiniup.com" : "https://oss-cn-hangzhou.aliyuncs.com"} />
                                    </Form.Item>
                                    <Form.Item
                                        name="cdnBaseUrl"
                                        label={isQiniuKodo ? "绑定域名（可选）" : "CDN 加速域名"}
                                        extra={isTencentCOS
                                            ? "选填。上传仍走 Endpoint，下载与预览改走 CDN；私有桶需开启 CDN 私有存储桶访问。CDN URL 不附带 COS 签名，未配置 CDN URL 鉴权时链接将长期可访问。"
                                            : isQiniuKodo
                                                ? "可选。填写后浏览器直连七牛私有下载地址；留空时采用“浏览器 -> 当前后端 /api/resources/:id/file -> 七牛 S3 Endpoint”的代理链路，后端使用 AK/SK 读取并返回文件，无需绑定域名。"
                                                : "选填。上传仍走 Endpoint，下载与预览改走 CDN；阿里云私有 Bucket 需开启 CDN 私有 Bucket 回源。CDN URL 不附带 OSS 签名，未配置 CDN URL 鉴权时链接将长期可访问。"}
                                        rules={[{ type: "url", message: "请填写完整的 http/https 地址" }]}
                                    >
                                        <Input autoComplete="off" inputMode="url" placeholder="https://media.example.com" />
                                    </Form.Item>
                                </div>
                                <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
                                    <Form.Item name="accessKeyId" label={accessKeyIdLabel}>
                                        <Input autoComplete="off" placeholder={isQiniuKodo ? "七牛云 AccessKey" : accessKeyIdLabel} />
                                    </Form.Item>
                                    <Form.Item name="accessKeySecret" label={hasCurrentProviderSecret ? `${accessKeySecretLabel}（${configuredSecretText}）` : accessKeySecretLabel}>
                                        <Input.Password autoComplete="new-password" placeholder={hasCurrentProviderSecret ? "留空保留原密钥" : accessKeySecretLabel} />
                                    </Form.Item>
                                </div>
                                <Form.Item name="publicBaseUrl" label="公共访问域名（选填）" tooltip="配置 CDN 或自定义域名后，预签名下载链接将使用此地址，不再拼接 bucket.endpoint。留空则使用 Endpoint 自动构造。">
                                    <Input autoComplete="off" placeholder="https://cdn.example.com" />
                                </Form.Item>
                            </div>
                        ) : (
                            <>
                                <Form.Item
                                    label="服务器访问地址"
                                    required
                                    tooltip="后端可从公网或模型服务所在网络访问的根地址，用于生成本地资源的短时签名链接。"
                                    name="publicBaseUrl"
                                    rules={[{ required: true, message: "请填写服务器访问地址" }, { type: "url", message: "请填写完整的 http/https 地址" }]}
                                >
                                    <Space.Compact className="w-full">
                                        <Input className="min-w-0" autoComplete="off" placeholder="https://canvas.example.com" prefix={<Globe className="size-4 text-foreground/35" />} />
                                        <Button icon={<LocateFixed className="size-4" />} onClick={() => form.setFieldValue("publicBaseUrl", window.location.origin)}>使用当前地址</Button>
                                    </Space.Compact>
                                </Form.Item>
                                <div className="border-t border-border py-4 text-xs leading-6 text-foreground/60">
                                    <div className="font-medium text-foreground/80">地址怎么设置</div>
                                    <div className="mt-1">域名已反向代理到本服务时，可点击“使用当前地址”，例如 <code className="text-foreground">https://ddcat.pronhubcn.com</code>。</div>
                                    <div>直接开放服务器端口时，填写完整的公网 IP 和端口，例如 <code className="text-foreground">http://103.242.14.110:300</code>。</div>
                                    <div>地址末尾不要填写 <code className="text-foreground">/api</code>；保存前可在浏览器访问 <code className="text-foreground">&lt;服务器访问地址&gt;/api/health</code>，看到 <code className="text-foreground">status: ok</code> 即表示入口正确。</div>
                                    <div className="mt-1 text-foreground/45">新增资源写入 <code>CANVAS_BACKEND_DATA_DIR/resources/</code>，部署时必须持久化该数据卷。供外部模型使用时，以上地址也必须能被模型服务访问，生产环境建议使用 HTTPS。</div>
                                </div>
                            </>
                        )}
                    </Form>
                </SettingsSectionCard>
                <div className="grid border-y border-border text-xs text-foreground/55 sm:grid-cols-3 sm:divide-x sm:divide-border"><Notice icon={isObjectStorage ? <Cloud className="size-3.5" /> : <HardDrive className="size-3.5" />} text={isObjectStorage ? `新资源写入${storageProviderLabel(mode as AdminOSSSetting["provider"])}` : "新资源写入服务器数据卷"} /><Notice icon={<ShieldCheck className="size-3.5" />} text="历史资源位置保持不变" /><Notice icon={<KeyRound className="size-3.5" />} text={isObjectStorage && cdnBaseUrl?.trim() ? "CDN 链接依赖 CDN 自身访问控制" : "外部链接仅在签名有效期内可用"} /></div>
            </div>
        </AdminPageFrame>
    );
}

function formValues(setting?: AdminOSSSetting | null): OSSFormValues {
    return {
        mode: setting?.enabled ? (setting.provider || "aliyun") : "local",
        publicBaseUrl: setting?.publicBaseUrl || "",
        region: setting?.region || "",
        endpoint: setting?.endpoint || "",
        cdnBaseUrl: setting?.cdnBaseUrl || "",
        bucket: setting?.bucket || "",
        accessKeyId: setting?.accessKeyId || "",
        accessKeySecret: "",
        pathPrefix: setting?.pathPrefix || "",
    };
}

function storageProviderLabel(provider?: AdminOSSSetting["provider"] | StorageMode) {
    return provider === "tencent" ? "腾讯云 COS" : provider === "qiniu" ? "七牛云 Kodo" : provider === "s3" ? "Amazon S3" : provider === "aliyun" ? "阿里云 OSS" : "服务器本地";
}

function formatTime(value?: string) {
    return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "--";
}

function Notice({ icon, text }: { icon: ReactNode; text: string }) {
    return <div className="flex items-center gap-2 px-3 py-2.5"><span className="text-foreground/40">{icon}</span><span>{text}</span></div>;
}
