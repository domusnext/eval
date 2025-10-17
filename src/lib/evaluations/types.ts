export type ProviderOptions = Record<string, unknown>;

export type TextPart = {
    type: "text";
    text: string;
};

export type ImagePart = {
    type: "image";
    /**
     * Source URI or data URL for the image content.
     */
    url: string;
    /**
     * Optional alternative text for accessibility.
     */
    alt?: string;
    /**
     * Optional hint to control provider-specific rendering fidelity.
     */
    detail?: "low" | "high";
    /**
     * Optional key in R2 storage backing this asset.
     */
    r2Key?: string;
    /**
     * Optional size metadata (in bytes).
     */
    size?: number;
    /**
     * Optional inferred mime type.
     */
    mimeType?: string;
};

export type FilePart = {
    type: "file";
    /**
     * Source URI for the file that the provider can fetch.
     */
    url: string;
    /**
     * Optional original filename shown to evaluators.
     */
    name?: string;
    /**
     * Optional MIME type when it cannot be inferred from the URL.
     */
    mimeType?: string;
    /**
     * Optional file size metadata.
     */
    size?: number;
    /**
     * Optional key in R2 storage backing this asset.
     */
    r2Key?: string;
};

export type MessagePart = TextPart | ImagePart | FilePart;

export type UserContent = string | MessagePart[];

export interface UserModelMessage {
    role: "user";
    content: UserContent;
    providerOptions?: ProviderOptions;
}

export interface AssistantModelMessage {
    role: "assistant";
    content: MessagePart[];
    providerOptions?: ProviderOptions;
}
