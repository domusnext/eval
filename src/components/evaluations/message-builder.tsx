"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    FileIcon,
    ImageIcon,
    Loader2,
    PlusCircle,
    Trash2,
    Type,
    Upload,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
    AssistantModelMessage,
    FilePart,
    ImagePart,
    MessagePart,
    ProviderOptions,
    TextPart,
    UserModelMessage,
} from "@/lib/evaluations/types";

type MessageRole = "user" | "assistant";

type DraftTextPart = TextPart & { id: string };
type DraftImagePart = ImagePart & { id: string };
type DraftFilePart = FilePart & { id: string };
type DraftPart = DraftTextPart | DraftImagePart | DraftFilePart;

type UploadKind = "image" | "file";

type UploadResponse = {
    url: string;
    key: string;
    size?: number;
    mimeType?: string;
    name?: string;
};

export type MessageBuilderProps = {
    role: MessageRole;
    message: UserModelMessage | AssistantModelMessage;
    onChange: (message: UserModelMessage | AssistantModelMessage) => void;
};

const createDraftPart = (type: MessagePart["type"]): DraftPart => {
    switch (type) {
        case "text":
            return {
                id: crypto.randomUUID(),
                type: "text",
                text: "",
            };
        case "image":
            return {
                id: crypto.randomUUID(),
                type: "image",
                url: "",
                alt: "",
                detail: "high",
            };
        case "file":
        default:
            return {
                id: crypto.randomUUID(),
                type: "file",
                url: "",
                name: "",
            };
    }
};

const normalizeMessageToParts = (
    role: MessageRole,
    message: UserModelMessage | AssistantModelMessage,
): DraftPart[] => {
    if (role === "user") {
        const content = (message as UserModelMessage).content;
        if (typeof content === "string") {
            return [
                {
                    id: crypto.randomUUID(),
                    type: "text",
                    text: content,
                },
            ];
        }
        return content.map((part) => ({ ...part, id: crypto.randomUUID() }));
    }

    return (message as AssistantModelMessage).content.map((part) => ({
        ...part,
        id: crypto.randomUUID(),
    }));
};

async function uploadToR2(
    file: File,
    kind: UploadKind,
): Promise<UploadResponse> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("type", kind);

    const response = await fetch("/api/uploads", {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Upload failed");
    }

    return (await response.json()) as UploadResponse;
}

export function MessageBuilder({
    role,
    message,
    onChange,
}: MessageBuilderProps) {
    const isHydratingRef = useRef(true);
    const [parts, setParts] = useState<DraftPart[]>(() =>
        normalizeMessageToParts(role, message),
    );
    const [providerOptionsText, setProviderOptionsText] = useState(() =>
        message.providerOptions
            ? JSON.stringify(message.providerOptions, null, 2)
            : "",
    );
    const [providerOptions, setProviderOptions] = useState<
        ProviderOptions | undefined
    >(message.providerOptions);
    const [providerOptionsError, setProviderOptionsError] = useState<
        string | null
    >(null);
    const [uploadingPartIds, setUploadingPartIds] = useState<
        Record<string, boolean>
    >({});

    // Track if we're in the middle of syncing from external message prop
    const isSyncingRef = useRef(false);

    useEffect(() => {
        isSyncingRef.current = true;
        setParts(normalizeMessageToParts(role, message));
        setProviderOptionsText(
            message.providerOptions
                ? JSON.stringify(message.providerOptions, null, 2)
                : "",
        );
        setProviderOptions(
            message.providerOptions as ProviderOptions | undefined,
        );
        setProviderOptionsError(null);
        // Reset sync flag after state updates
        setTimeout(() => {
            isSyncingRef.current = false;
        }, 0);
    }, [message, role]);

    const emitChange = useCallback((
        draftParts: DraftPart[],
        providerOptionsValue: ProviderOptions | undefined,
    ) => {
        const sanitizedParts = draftParts
            .map(({ id, ...part }) => part)
            .filter((part) => {
                if (part.type === "text") {
                    return part.text.trim().length > 0;
                }
                return part.url.trim().length > 0;
            }) as MessagePart[];

        if (role === "user") {
            let content: UserModelMessage["content"];
            if (sanitizedParts.length === 0) {
                content = "";
            } else if (
                sanitizedParts.length === 1 &&
                sanitizedParts[0].type === "text"
            ) {
                content = sanitizedParts[0].text;
            } else {
                content = sanitizedParts;
            }

            const payload: UserModelMessage = {
                role: "user",
                content,
                ...(providerOptionsValue
                    ? { providerOptions: providerOptionsValue }
                    : {}),
            };
            onChange(payload);
        } else {
            const payload: AssistantModelMessage = {
                role: "assistant",
                content: sanitizedParts,
                ...(providerOptionsValue
                    ? { providerOptions: providerOptionsValue }
                    : {}),
            };
            onChange(payload);
        }
    }, [onChange, role]);

    useEffect(() => {
        if (!providerOptionsText.trim()) {
            setProviderOptions(undefined);
            setProviderOptionsError(null);
            return;
        }

        try {
            const parsed = JSON.parse(providerOptionsText) as ProviderOptions;
            setProviderOptions(parsed);
            setProviderOptionsError(null);
        } catch (error) {
            setProviderOptionsError((error as Error).message);
        }
    }, [providerOptionsText]);

    useEffect(() => {
        // Don't emit changes when we're syncing from the external message prop
        if (isSyncingRef.current || providerOptionsError) return;
        emitChange(parts, providerOptions);
    }, [parts, providerOptions, providerOptionsError, emitChange]);

    const setPartUploading = (partId: string, uploading: boolean) => {
        setUploadingPartIds((prev) => ({ ...prev, [partId]: uploading }));
    };

    const handleAddPart = (type: MessagePart["type"]) => {
        setParts((prev) => [...prev, createDraftPart(type)]);
    };

    const handleRemovePart = (partId: string) => {
        setParts((prev) => {
            const next = prev.filter((part) => part.id !== partId);
            if (next.length === 0) {
                return [createDraftPart("text")];
            }
            return next;
        });
    };

    const handleUpdatePart = (partId: string, updates: Partial<DraftPart>) => {
        setParts((prev) =>
            prev.map((part) =>
                part.id === partId
                    ? ({
                        ...part,
                        ...updates,
                    } as DraftPart)
                    : part,
            ),
        );
    };

    const handleUpload = async (part: DraftPart, kind: UploadKind) => {
        const accept = kind === "image" ? "image/*" : "*/*";
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                setPartUploading(part.id, true);
                const result = await uploadToR2(file, kind);

                if (kind === "image") {
                    const updates: Partial<DraftImagePart> = {
                        url: result.url,
                        mimeType: result.mimeType ?? file.type,
                        size: result.size ?? file.size,
                        r2Key: result.key,
                    };
                    if (!("alt" in part) || !part.alt) {
                        updates.alt = file.name
                            .replace(/\.[^/.]+$/, "")
                            .replace(/[-_]+/g, " ")
                            .trim();
                    }
                    handleUpdatePart(part.id, updates);
                } else {
                    const updates: Partial<DraftFilePart> = {
                        url: result.url,
                        name: result.name ?? file.name,
                        mimeType: result.mimeType ?? file.type,
                        size: result.size ?? file.size,
                        r2Key: result.key,
                    };
                    handleUpdatePart(part.id, updates);
                }

                toast.success("Uploaded to R2");
            } catch (error) {
                toast.error((error as Error).message);
            } finally {
                setPartUploading(part.id, false);
            }
        };
        input.click();
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold capitalize text-slate-700">
                    {role === "user" ? "User message" : "Assistant message"}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleAddPart("text")}
                    >
                        <Type className="mr-2 size-4" />
                        Text
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleAddPart("image")}
                    >
                        <ImageIcon className="mr-2 size-4" />
                        Image
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleAddPart("file")}
                    >
                        <FileIcon className="mr-2 size-4" />
                        File
                    </Button>
                </div>
            </div>

            <div className="space-y-3">
                {parts.map((part, index) => (
                    <div
                        key={part.id}
                        className="space-y-3 rounded-lg border bg-white p-4 shadow-xs"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                                <PlusCircle className="size-3.5 rotate-45 text-slate-400" />
                                Part {index + 1} ·{" "}
                                <span className="capitalize">{part.type}</span>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRemovePart(part.id)}
                                aria-label="Remove part"
                            >
                                <Trash2 className="size-4 text-slate-500" />
                            </Button>
                        </div>

                        {part.type === "text" ? (
                            <Textarea
                                rows={4}
                                value={part.text}
                                placeholder="Enter text content..."
                                onChange={(event) =>
                                    handleUpdatePart(part.id, {
                                        text: event.target.value,
                                    })
                                }
                            />
                        ) : null}

                        {part.type === "image" ? (
                            <div className="space-y-3">
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor={`image-url-${part.id}`}>
                                            Image URL
                                        </Label>
                                        <Input
                                            id={`image-url-${part.id}`}
                                            value={part.url}
                                            placeholder="https://..."
                                            onChange={(event) =>
                                                handleUpdatePart(part.id, {
                                                    url: event.target.value,
                                                })
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor={`image-alt-${part.id}`}>
                                            Alt text (optional)
                                        </Label>
                                        <Input
                                            id={`image-alt-${part.id}`}
                                            value={part.alt ?? ""}
                                            placeholder="Describe the image content"
                                            onChange={(event) =>
                                                handleUpdatePart(part.id, {
                                                    alt: event.target.value,
                                                })
                                            }
                                        />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            handleUpload(part, "image")
                                        }
                                        disabled={uploadingPartIds[part.id]}
                                    >
                                        {uploadingPartIds[part.id] ? (
                                            <Loader2 className="mr-2 size-4 animate-spin" />
                                        ) : (
                                            <Upload className="mr-2 size-4" />
                                        )}
                                        Upload to R2
                                    </Button>
                                    {part.mimeType ? (
                                        <span>{part.mimeType}</span>
                                    ) : null}
                                    {typeof part.size === "number" ? (
                                        <span>{formatBytes(part.size)}</span>
                                    ) : null}
                                </div>
                                {part.url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={part.url}
                                        alt={part.alt ?? ""}
                                        className="h-40 w-auto rounded-md border object-cover"
                                    />
                                ) : null}
                            </div>
                        ) : null}

                        {part.type === "file" ? (
                            <div className="space-y-3">
                                <div className="space-y-2">
                                    <Label htmlFor={`file-url-${part.id}`}>
                                        File URL
                                    </Label>
                                    <Input
                                        id={`file-url-${part.id}`}
                                        value={part.url}
                                        placeholder="https://..."
                                        onChange={(event) =>
                                            handleUpdatePart(part.id, {
                                                url: event.target.value,
                                            })
                                        }
                                    />
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor={`file-name-${part.id}`}>
                                            Display name
                                        </Label>
                                        <Input
                                            id={`file-name-${part.id}`}
                                            value={part.name ?? ""}
                                            placeholder="Optional friendly name"
                                            onChange={(event) =>
                                                handleUpdatePart(part.id, {
                                                    name: event.target.value,
                                                })
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor={`file-mime-${part.id}`}>
                                            MIME type
                                        </Label>
                                        <Input
                                            id={`file-mime-${part.id}`}
                                            value={part.mimeType ?? ""}
                                            placeholder="application/pdf"
                                            onChange={(event) =>
                                                handleUpdatePart(part.id, {
                                                    mimeType:
                                                        event.target.value,
                                                })
                                            }
                                        />
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            handleUpload(part, "file")
                                        }
                                        disabled={uploadingPartIds[part.id]}
                                    >
                                        {uploadingPartIds[part.id] ? (
                                            <Loader2 className="mr-2 size-4 animate-spin" />
                                        ) : (
                                            <Upload className="mr-2 size-4" />
                                        )}
                                        Upload to R2
                                    </Button>
                                    {part.mimeType ? (
                                        <span>{part.mimeType}</span>
                                    ) : null}
                                    {typeof part.size === "number" ? (
                                        <span>{formatBytes(part.size)}</span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>

            <div className="space-y-2">
                <Label htmlFor={`${role}-provider-options`}>
                    Provider options (JSON, optional)
                </Label>
                <Textarea
                    id={`${role}-provider-options`}
                    rows={4}
                    value={providerOptionsText}
                    placeholder="{}"
                    onChange={(event) =>
                        setProviderOptionsText(event.target.value)
                    }
                />
                {providerOptionsError ? (
                    <p className="text-sm text-red-500">
                        {providerOptionsError}
                    </p>
                ) : (
                    <p className="text-xs text-slate-500">
                        Use provider options to send extra metadata to
                        downstream models.
                    </p>
                )}
            </div>
        </div>
    );
}

function formatBytes(bytes?: number, decimals = 1) {
    if (bytes === undefined) return "";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}
