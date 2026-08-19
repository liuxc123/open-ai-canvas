import { FileText, ImageIcon, Music2, Pencil, Sparkles, UserRound, Video } from "lucide-react";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType } from "@/types/canvas";

type ResourcePreviewContentProps = {
    reference: CanvasResourceReference;
    maxMediaSize?: number;
    maxTextWidth?: number;
};

export function ResourcePreviewContent({ reference, maxMediaSize = 240, maxTextWidth = 300 }: ResourcePreviewContentProps) {
    const hasMedia = (reference.kind === "image" || reference.kind === "video" || reference.kind === "character") && Boolean(reference.previewUrl);

    return (
        <div className="flex flex-col items-center gap-1.5 p-2">
            {hasMedia ? <MediaPreview reference={reference} maxSize={maxMediaSize} /> : <NonMediaPreview reference={reference} maxWidth={maxTextWidth} />}
            <div className="flex items-center gap-1.5 px-0.5 pb-0.5">
                <span className="text-xs font-semibold">{reference.label}</span>
                <span className="text-[var(--fs-micro)] opacity-60 truncate">{reference.title}</span>
            </div>
        </div>
    );
}

function MediaPreview({ reference, maxSize }: { reference: CanvasResourceReference; maxSize: number }) {
    if (reference.kind === "video" && reference.previewUrl) {
        return (
            <video
                src={reference.previewUrl}
                controls
                muted
                autoPlay
                loop
                preload="metadata"
                style={{ maxWidth: maxSize, maxHeight: maxSize, borderRadius: 8 }}
                className="block bg-black"
            />
        );
    }
    if (reference.kind === "character" && reference.previewUrl) {
        return (
            <img
                src={reference.previewUrl}
                alt={reference.title || reference.label}
                style={{ maxWidth: maxSize, maxHeight: maxSize, borderRadius: 8 }}
                className="block bg-black/5 object-contain"
            />
        );
    }
    return (
        <img
            src={reference.previewUrl}
            alt={reference.title || reference.label}
            style={{ maxWidth: maxSize, maxHeight: maxSize, borderRadius: 8 }}
            className="block object-contain"
        />
    );
}

function NonMediaPreview({ reference, maxWidth }: { reference: CanvasResourceReference; maxWidth: number }) {
    if (reference.kind === "skill") {
        return (
            <div className="flex items-center gap-2 rounded-lg bg-cyan-500/10 p-2.5" style={{ maxWidth }}>
                <Sparkles className="size-4 shrink-0 text-cyan-600 dark:text-cyan-200" />
                <span className="text-xs opacity-70">{reference.skill?.description || reference.text || "技能"}</span>
            </div>
        );
    }

    if (reference.text) {
        return (
            <p className="line-clamp-4 whitespace-pre-wrap rounded-lg bg-black/5 p-2.5 text-[var(--fs-tiny)] leading-relaxed opacity-70 dark:bg-white/5" style={{ maxWidth }}>
                {reference.text}
            </p>
        );
    }

    const Icon = reference.sourceType === CanvasNodeType.Drawing ? Pencil : reference.kind === "character" ? UserRound : reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <div className="flex items-center gap-2 rounded-lg bg-black/5 p-2.5 dark:bg-white/5" style={{ maxWidth }}>
            <Icon className="size-4 shrink-0 opacity-60" />
            <span className="text-xs opacity-60">无预览内容</span>
        </div>
    );
}
