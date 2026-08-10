import { CheckCircle2, Loader2, XCircle, AlertTriangle, CircleDashed } from "lucide-react";
import { Tag } from "antd";

export type SeedanceAssetStatusValue =
    | "approved"
    | "submitting"
    | "submitted"
    | "processing"
    | "failed"
    | "expired"
    | "unregistered";

export function SeedanceAssetStatus({
    status,
    onRetry,
}: {
    status: SeedanceAssetStatusValue;
    onRetry?: () => void;
}) {
    switch (status) {
        case "approved":
            return (
                <Tag icon={<CheckCircle2 size={12} />} color="success">
                    已通过
                </Tag>
            );
        case "submitting":
            return (
                <Tag icon={<Loader2 size={12} className="animate-spin" />} color="warning">
                    注册中
                </Tag>
            );
        case "submitted":
        case "processing":
            return (
                <Tag icon={<Loader2 size={12} className="animate-spin" />} color="warning">
                    审核中
                </Tag>
            );
        case "failed":
            return (
                <Tag icon={<XCircle size={12} />} color="error">
                    审核失败
                    {onRetry && (
                        <a onClick={onRetry} className="ml-1">
                            重试
                        </a>
                    )}
                </Tag>
            );
        case "expired":
            return (
                <Tag icon={<AlertTriangle size={12} />} color="default">
                    已过期
                    {onRetry && (
                        <a onClick={onRetry} className="ml-1">
                            重新注册
                        </a>
                    )}
                </Tag>
            );
        default:
            return (
                <Tag icon={<CircleDashed size={12} />} color="default">
                    未注册
                    {onRetry && (
                        <a onClick={onRetry} className="ml-1">
                            注册
                        </a>
                    )}
                </Tag>
            );
    }
}
