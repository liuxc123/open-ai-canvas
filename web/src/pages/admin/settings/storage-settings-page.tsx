import { App, Button, Form, Input, Segmented, Space, Tag } from "antd";
import { Cloud, Globe, HardDrive, Info, KeyRound, LocateFixed, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getAdminOSSSetting, testAdminOSSSetting, updateAdminOSSSetting, type AdminOSSSetting } from "@/services/api/auth";
import type { StorageProvider } from "@/services/api/resources";
import { useAdminContext } from "../admin-context";
import { AdminPageFrame } from "../components/admin-shell";
import { configuredSecretText, SettingsSectionCard } from "../components/admin-ui";

type StorageMode = "local" | StorageProvider;
type OSSFormValues = { mode: StorageMode; publicBaseUrl?: string; region?: string; endpoint?: string; bucket?: string; accessKeyId?: string; accessKeySecret?: string; pathPrefix?: string };

const providerLabels: Record<StorageProvider, string> = {
    aliyun: "阿里云 OSS",
    tencent: "腾讯云 COS",
    s3: "Amazon S3",
};

const providerPlaceholders: Record<StorageProvider, { region: string; endpoint: string; accessKeyId: string; accessKeySecret: string }> = {
    aliyun: { region: "oss-cn-hangzhou", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", accessKeyId: "阿里云 AccessKey ID", accessKeySecret: "阿里云 AccessKey Secret" },
    tencent: { region: "ap-guangzhou", endpoint: "https://cos.ap-guangzhou.myqcloud.com", accessKeyId: "腾讯云 SecretId", accessKeySecret: "腾讯云 SecretKey" },
    s3: { region: "us-east-1", endpoint: "https://s3.us-east-1.amazonaws.com", accessKeyId: "AWS Access Key ID", accessKeySecret: "AWS Secret Access Key" },
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

    const test = async () => {
        const values = form.getFieldsValue(true);
        const isCloud = values.mode !== "local";
        if (!isCloud) return;
        if (!values.bucket?.trim()) return message.error("请填写 Bucket");
        if (!values.endpoint?.trim()) return message.error("请填写 Endpoint");
        if (!values.accessKeyId?.trim()) return message.error("请填写 AccessKey ID");
        if (!values.accessKeySecret?.trim() && !hasSavedSecret) return message.error("请填写 AccessKey Secret");
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

    useEffect(() => {
        void getAdminOSSSetting()
            .then(({ setting: value }) => { setSetting(value); form.setFieldsValue(formValues(value)); })
            .catch((error) => message.error(error instanceof Error ? error.message : "读取 OSS 配置失败"))
            .finally(() => setLoading(false));
    }, [form, message]);

    const save = async () => {
        await form.validateFields();
        const values = form.getFieldsValue(true);
        const isCloud = values.mode !== "local";
        if (!isCloud && !values.publicBaseUrl?.trim()) return message.error("请填写服务器访问地址");
        if (isCloud && !values.bucket?.trim()) return message.error("请填写 Bucket");
        if (isCloud && !values.endpoint?.trim()) return message.error("请填写 Endpoint");
        if (isCloud && !values.accessKeyId?.trim()) return message.error("请填写 AccessKey ID");
        if (isCloud && !values.accessKeySecret?.trim() && !hasSavedSecret) return message.error("请填写 AccessKey Secret");
        if (isCloud && (values.mode === "tencent" || values.mode === "s3") && !values.region?.trim()) return message.error("请填写 Region");
        setSaving(true);
        try {
            const provider = (isCloud ? values.mode : "aliyun") as StorageProvider;
            const result = await updateAdminOSSSetting({ enabled: isCloud, provider, region: values.region?.trim() || "", endpoint: values.endpoint?.trim() || "", bucket: values.bucket?.trim() || "", accessKeyId: values.accessKeyId?.trim() || "", accessKeySecret: values.accessKeySecret?.trim() || "", publicBaseUrl: values.publicBaseUrl?.trim() || "", pathPrefix: values.pathPrefix?.trim() || "" });
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
        <AdminPageFrame title="存储服务" description="配置新增资源的默认存储位置">
            <div className="space-y-4 pt-4">
                <div className="border-b border-border px-1 pb-4 text-foreground/75">
                    <div className="flex items-start gap-3"><span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-muted/60"><Info className="size-4" /></span><div><div className="text-sm font-semibold text-foreground">资源存储规则</div><p className="mt-1 text-xs leading-6 text-foreground/55">存储类型只影响之后新增的媒体资源，不迁移或改写历史文件。日常读取继续校验登录态，仅在模型必须通过 URL 拉取本地素材时生成短时签名链接。</p></div></div>
                </div>
                <SettingsSectionCard
                    icon={<Cloud className="size-4" />}
                    title="平台存储"
                    description="选择平台新增媒体资源的默认写入方式。"
                    status={<Space size={6}><Tag variant="filled" color={setting?.enabled ? "blue" : "default"}>{setting?.enabled ? providerLabels[setting.provider] || "云存储" : "服务器本地"}</Tag>{setting?.enabled ? <Tag variant="filled" color={setting.hasAccessKeySecret ? "success" : "warning"}>{setting.hasAccessKeySecret ? configuredSecretText : "未保存密钥"}</Tag> : null}</Space>}
                    footer={<><div className="text-xs text-foreground/45">{setting?.updatedAt ? `上次更新：${formatTime(setting.updatedAt)}${setting.updatedBy ? ` · ${userNameById.get(setting.updatedBy) || setting.updatedBy}` : ""}` : "尚未保存平台存储配置"}</div><div className="flex items-center gap-2">{mode !== "local" && <Button icon={<Zap className="size-4" />} loading={testing} onClick={() => void test()}>测试连接</Button>}<Button type="primary" loading={saving} onClick={() => void save()}>保存存储配置</Button></div></>}
                >
                    <Form form={form} layout="vertical" requiredMark={false} disabled={loading}>
                        <div className="grid grid-cols-1 gap-x-5 px-5 pt-5 md:grid-cols-2">
                            <Form.Item className="md:col-span-2" name="mode" label="存储类型" rules={[{ required: true, message: "请选择存储类型" }]}>
                                <Segmented<StorageMode>
                                    block
                                    options={[
                                        { label: <span className="inline-flex items-center gap-2"><HardDrive className="size-4" />服务器本地</span>, value: "local" },
                                        { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />阿里云 OSS</span>, value: "aliyun" },
                                        { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />腾讯云 COS</span>, value: "tencent" },
                                        { label: <span className="inline-flex items-center gap-2"><Cloud className="size-4" />Amazon S3</span>, value: "s3" },
                                    ]}
                                />
                            </Form.Item>
                            {mode !== "local" ? (
                                <>
                                    {(() => { const ph = providerPlaceholders[mode as StorageProvider] || providerPlaceholders.aliyun; return (
                                    <>
                                    <Form.Item name="region" label="Region"><Input autoComplete="off" placeholder={ph.region} /></Form.Item>
                                    <Form.Item name="endpoint" label="Endpoint"><Input autoComplete="off" placeholder={ph.endpoint} /></Form.Item>
                                    <Form.Item name="bucket" label="Bucket"><Input autoComplete="off" placeholder="例如：my-canvas-assets" /></Form.Item>
                                    <Form.Item name="pathPrefix" label="路径前缀"><Input autoComplete="off" placeholder="例如：uploads/infinite-canvas" /></Form.Item>
                                    <Form.Item name="accessKeyId" label="AccessKey ID"><Input autoComplete="off" placeholder={ph.accessKeyId} /></Form.Item>
                                    <Form.Item name="accessKeySecret" label={hasSavedSecret ? `AccessKey Secret（${configuredSecretText}）` : "AccessKey Secret"}><Input.Password autoComplete="new-password" placeholder={hasSavedSecret ? "留空保留原密钥" : ph.accessKeySecret} /></Form.Item>
                                    <Form.Item className="md:col-span-2" name="publicBaseUrl" label="公共访问域名（选填）" tooltip="配置 CDN 或自定义域名后，预签名下载链接将使用此地址，不再拼接 bucket.endpoint。留空则使用 Endpoint 自动构造。"><Input autoComplete="off" placeholder="https://cdn.example.com" /></Form.Item>
                                    </>
                                    ); })()}
                                </>
                            ) : (
                                <>
                                    <Form.Item className="md:col-span-2" label="服务器访问地址" required tooltip="后端可从公网或模型服务所在网络访问的根地址，用于生成本地资源的短时签名链接。">
                                        <Space.Compact className="w-full">
                                            <Form.Item
                                                name="publicBaseUrl"
                                                noStyle
                                                rules={[
                                                    { required: true, message: "请填写服务器访问地址" },
                                                    { type: "url", message: "请填写完整的 http/https 地址" },
                                                ]}
                                            >
                                                <Input className="min-w-0" autoComplete="off" placeholder="https://canvas.example.com 或 http://103.242.14.110:300" prefix={<Globe className="size-4 text-foreground/35" />} />
                                            </Form.Item>
                                            <Button icon={<LocateFixed className="size-4" />} onClick={() => form.setFieldValue("publicBaseUrl", window.location.origin)}>使用当前地址</Button>
                                        </Space.Compact>
                                    </Form.Item>
                                    <div className="md:col-span-2 border-t border-border py-4 text-xs leading-6 text-foreground/60">
                                        <div className="font-medium text-foreground/80">地址怎么设置</div>
                                        <div className="mt-1">域名已反向代理到本服务时，可点击“使用当前地址”，例如 <code className="text-foreground">https://ddcat.pronhubcn.com</code>。</div>
                                        <div>直接开放服务器端口时，填写完整的公网 IP 和端口，例如 <code className="text-foreground">http://103.242.14.110:300</code>。</div>
                                        <div>地址末尾不要填写 <code className="text-foreground">/api</code>；保存前可在浏览器访问 <code className="text-foreground">&lt;服务器访问地址&gt;/api/health</code>，看到 <code className="text-foreground">status: ok</code> 即表示入口正确。</div>
                                        <div className="mt-1 text-foreground/45">新增资源写入 <code>CANVAS_BACKEND_DATA_DIR/resources/</code>，部署时必须持久化该数据卷。供外部模型使用时，以上地址也必须能被模型服务访问，生产环境建议使用 HTTPS。</div>
                                    </div>
                                </>
                            )}
                        </div>
                    </Form>
                </SettingsSectionCard>
                <div className="grid border-y border-border text-xs text-foreground/55 sm:grid-cols-3 sm:divide-x sm:divide-border"><Notice icon={mode !== "local" ? <Cloud className="size-3.5" /> : <HardDrive className="size-3.5" />} text={mode !== "local" ? `新资源写入${providerLabels[mode as StorageProvider] || "云存储"}` : "新资源写入服务器数据卷"} /><Notice icon={<ShieldCheck className="size-3.5" />} text="历史资源位置保持不变" /><Notice icon={<KeyRound className="size-3.5" />} text="外部链接仅在签名有效期内可用" /></div>
            </div>
        </AdminPageFrame>
    );
}

function formValues(setting?: AdminOSSSetting | null): OSSFormValues { return { mode: setting?.enabled ? (setting.provider || "aliyun") : "local", publicBaseUrl: setting?.publicBaseUrl || "", region: setting?.region || "", endpoint: setting?.endpoint || "", bucket: setting?.bucket || "", accessKeyId: setting?.accessKeyId || "", accessKeySecret: "", pathPrefix: setting?.pathPrefix || "" }; }
function formatTime(value?: string) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "--"; }
function Notice({ icon, text }: { icon: ReactNode; text: string }) { return <div className="flex items-center gap-2 px-3 py-2.5"><span className="text-foreground/40">{icon}</span><span>{text}</span></div>; }
