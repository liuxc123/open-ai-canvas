import { App, Button, Form, Input, Select, Switch, Tag } from "antd";
import { Cloud, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getUserOSSSetting, testUserOSSSetting, updateUserOSSSetting, type StorageProvider, type UserOSSSetting } from "@/services/api/resources";
import { useUserStore } from "@/stores/use-user-store";

const providerPlaceholders: Record<StorageProvider, { region: string; endpoint: string; accessKeyId: string; accessKeySecret: string }> = {
    aliyun: { region: "oss-cn-hangzhou", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", accessKeyId: "阿里云 AccessKey ID", accessKeySecret: "阿里云 AccessKey Secret" },
    tencent: { region: "ap-guangzhou", endpoint: "https://cos.ap-guangzhou.myqcloud.com", accessKeyId: "腾讯云 SecretId", accessKeySecret: "腾讯云 SecretKey" },
    s3: { region: "us-east-1", endpoint: "https://s3.us-east-1.amazonaws.com", accessKeyId: "AWS Access Key ID", accessKeySecret: "AWS Secret Access Key" },
};

type OSSFormValues = {
    enabled?: boolean;
    provider: StorageProvider;    region?: string;
    endpoint?: string;
    cdnBaseUrl?: string;
    bucket?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    pathPrefix?: string;
    publicBaseUrl?: string;
};

export function UserOSSSettingsForm() {
    const actor = useUserStore((state) => state.user);
    const { message } = App.useApp();
    const [form] = Form.useForm<OSSFormValues>();
    const [setting, setSetting] = useState<UserOSSSetting | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const savedAt = formatSavedAt(setting?.updatedAt);
    const provider = Form.useWatch("provider", form) || "aliyun";
    const isTencentCOS = provider === "tencent";
    const ph = providerPlaceholders[provider] || providerPlaceholders.aliyun;
    const prevProviderRef = useRef<StorageProvider>(provider);
    const cloudDraftsRef = useRef<Partial<Record<StorageProvider, Partial<OSSFormValues>>>>({});
    const hasCurrentProviderSecret = Boolean(setting && setting.provider === provider && setting.hasAccessKeySecret);
    const accessKeyIdLabel = isTencentCOS ? "SecretId" : "AccessKey ID";
    const accessKeySecretLabel = isTencentCOS ? "SecretKey" : "AccessKey Secret";

    useEffect(() => {
        if (prevProviderRef.current && prevProviderRef.current !== provider) {
            const all = form.getFieldsValue(true);
            cloudDraftsRef.current[prevProviderRef.current] = {
                region: all.region, endpoint: all.endpoint, bucket: all.bucket,
                accessKeyId: all.accessKeyId, accessKeySecret: all.accessKeySecret,
                pathPrefix: all.pathPrefix, publicBaseUrl: all.publicBaseUrl,
            };
            const cached = cloudDraftsRef.current[provider];
            form.setFieldsValue({
                region: "", endpoint: "", bucket: "", accessKeyId: "",
                accessKeySecret: "", pathPrefix: "", publicBaseUrl: "", cdnBaseUrl: "",
                ...cached,
            });
        }
        prevProviderRef.current = provider;
    }, [provider, form]);

    useEffect(() => {
        if (!actor?.id) return;
        let active = true;
        setLoading(true);
        void getUserOSSSetting()
            .then((data) => {
                if (!active) return;
                setSetting(data.setting);
                form.setFieldsValue(toFormValues(data.setting));
            })
            .catch((error) => active && message.error(error instanceof Error ? error.message : "读取个人对象存储配置失败"))
            .finally(() => active && setLoading(false));
        return () => {
            active = false;
        };
    }, [actor?.id, form, message]);

    if (!actor) {
        return <div className="rounded-md border border-dashed border-border px-5 py-10 text-center text-sm text-foreground/55">登录后可配置个人对象存储。</div>;
    }

    const test = async () => {
        const values = await form.validateFields();
        setTesting(true);
        try {
            await testUserOSSSetting({
                enabled: true,
                provider: values.provider || "aliyun",
                region: values.region?.trim() || "",
                endpoint: values.endpoint?.trim() || "",
                cdnBaseUrl: values.cdnBaseUrl?.trim() || "",
                bucket: values.bucket?.trim() || "",
                accessKeyId: values.accessKeyId?.trim() || "",
                accessKeySecret: values.accessKeySecret?.trim() || "",
                pathPrefix: values.pathPrefix?.trim() || "",
                publicBaseUrl: values.publicBaseUrl?.trim() || "",
            });
            message.success("连接测试成功，存储配置可用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "连接测试失败");
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            const data = await updateUserOSSSetting({
                enabled: values.enabled === true,
                provider: values.provider || "aliyun",
                region: values.region?.trim() || "",
                endpoint: values.endpoint?.trim() || "",
                cdnBaseUrl: values.cdnBaseUrl?.trim() || "",
                bucket: values.bucket?.trim() || "",
                accessKeyId: values.accessKeyId?.trim() || "",
                accessKeySecret: values.accessKeySecret?.trim() || "",
                pathPrefix: values.pathPrefix?.trim() || "",
                publicBaseUrl: values.publicBaseUrl?.trim() || "",
            });
            setSetting(data.setting);
            form.setFieldsValue(toFormValues(data.setting));
            message.success(data.setting.enabled ? "个人对象存储已启用，后续上传将优先使用该存储" : "个人对象存储已停用，后续上传将使用平台存储");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存个人对象存储配置失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Form form={form} layout="vertical" requiredMark={false} disabled={loading}>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        <Cloud className="size-4" />
                        我的对象存储
                    </div>
                    <p className="mt-1 max-w-3xl text-xs leading-5 text-foreground/55">支持阿里云 OSS 与腾讯云 COS。启用后，新上传和新生成的媒体优先写入你的存储桶；停用时回退到平台存储。历史资源继续使用创建时的存储与密钥配置，同一存储位置的 CDN 域名会跟随当前配置。</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <Tag color={setting?.enabled ? "success" : "default"}>{setting?.enabled ? "已启用" : "未启用"}</Tag>
                    <Tag color={setting?.hasAccessKeySecret ? "processing" : "warning"} icon={<ShieldCheck className="size-3" />}>
                        {setting?.hasAccessKeySecret ? "密钥已加密" : "未保存密钥"}
                    </Tag>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2 xl:grid-cols-3">
                <Form.Item name="enabled" label="启用个人对象存储" valuePropName="checked" className="mb-3">
                    <Switch checkedChildren="启用" unCheckedChildren="停用" />
                </Form.Item>
                <Form.Item name="provider" label="存储服务" rules={[{ required: true, message: "请选择存储服务" }]} className="mb-3">
                    <Select
                        options={[{ label: "阿里云 OSS", value: "aliyun" }, { label: "腾讯云 COS", value: "tencent" }, { label: "Amazon S3", value: "s3" }]}
                        onChange={(nextProvider: OSSFormValues["provider"]) => {
                            if (nextProvider !== provider) form.setFieldsValue({ region: "", endpoint: "", cdnBaseUrl: "", bucket: "", accessKeyId: "", accessKeySecret: "" });
                        }}
                    />
                </Form.Item>
                <Form.Item name="region" label="Region" className="mb-3">
                    <Input spellCheck={false} placeholder={ph.region} />
                </Form.Item>
                <Form.Item name="endpoint" label="Endpoint" extra={isTencentCOS ? "可留空，系统会根据 Region 生成标准 COS Endpoint。" : undefined} className="mb-3">
                    <Input inputMode="url" spellCheck={false} placeholder={ph.endpoint} />
                </Form.Item>
                <Form.Item
                    name="cdnBaseUrl"
                    label="CDN 加速域名"
                    extra={isTencentCOS
                        ? "选填。上传仍走 Endpoint，下载与预览改走 CDN；私有桶需开启 CDN 私有存储桶访问。CDN URL 不附带 COS 签名，未配置 CDN URL 鉴权时链接将长期可访问。"
                        : "选填。上传仍走 Endpoint，下载与预览改走 CDN；阿里云私有 Bucket 需开启 CDN 私有 Bucket 回源。CDN URL 不附带 OSS 签名，未配置 CDN URL 鉴权时链接将长期可访问。"}
                    rules={[{ type: "url", message: "请填写完整的 http/https CDN 加速域名" }]}
                    className="mb-3"
                >
                    <Input inputMode="url" spellCheck={false} placeholder="https://media.example.com" />
                </Form.Item>
                <Form.Item name="bucket" label="Bucket" className="mb-3">
                    <Input spellCheck={false} placeholder={isTencentCOS ? "my-canvas-assets-1250000000" : "my-canvas-assets"} />
                </Form.Item>
                <Form.Item name="pathPrefix" label="路径前缀" className="mb-3">
                    <Input spellCheck={false} placeholder="infinite-canvas" />
                </Form.Item>
                <Form.Item name="accessKeyId" label={accessKeyIdLabel} className="mb-3 xl:col-span-1">
                    <Input autoComplete="off" spellCheck={false} placeholder={ph.accessKeyId} />
                </Form.Item>
                <Form.Item name="accessKeySecret" label={hasCurrentProviderSecret ? `${accessKeySecretLabel}（留空保留）` : accessKeySecretLabel} className="mb-3 xl:col-span-2">
                    <Input.Password autoComplete="new-password" spellCheck={false} placeholder={hasCurrentProviderSecret ? "留空保留已加密密钥" : ph.accessKeySecret} />
                </Form.Item>
                <Form.Item className="mb-3" name="publicBaseUrl" label="公共访问域名（选填）" tooltip="配置 CDN 或自定义域名后，预签名下载链接将使用此地址，不再拼接 bucket.endpoint。留空则使用 Endpoint 自动构造。">
                    <Input spellCheck={false} placeholder="https://cdn.example.com" />
                </Form.Item>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <span className="text-xs text-foreground/50">{savedAt ? `上次保存：${savedAt}` : "尚未保存个人对象存储配置"}</span>
                <div className="flex items-center gap-2">
                    <Button icon={<Zap className="size-4" />} loading={testing} onClick={() => void test()}>
                        测试连接
                    </Button>
                    <Button type="primary" loading={saving} onClick={() => void save()}>
                        保存个人对象存储
                    </Button>
                </div>
            </div>
        </Form>
    );
}

function formatSavedAt(value?: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return "";
    return date.toLocaleString("zh-CN");
}

function toFormValues(setting: UserOSSSetting): OSSFormValues {
    return {
        enabled: setting.enabled,
        provider: setting.provider || "aliyun",
        region: setting.region,
        endpoint: setting.endpoint,
        cdnBaseUrl: setting.cdnBaseUrl,
        bucket: setting.bucket,
        accessKeyId: setting.accessKeyId,
        accessKeySecret: "",
        pathPrefix: setting.pathPrefix,
        publicBaseUrl: setting.publicBaseUrl,
    };
}
