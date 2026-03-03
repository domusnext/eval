/**
 * 将 SSE responseContent 转换为标准消息格式
 * 用于保存 Case 执行结果到 Context 的 recent_messages
 */

import type { UserModelMessage } from "./types";

interface SSEEvent {
    type?: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    input?: Record<string, unknown>;
    output?: {
        success?: boolean;
        modelVisibleData?: {
            data?: unknown;
        };
    };
    [key: string]: unknown;
}

interface TextContent {
    type: "text";
    text: string;
}

interface ToolCallContent {
    type: "tool_call";
    tool_call: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    };
}

interface ToolResultContent {
    type: "tool_result";
    tool_result: {
        name: string;
        content: string;  // 必须是字符串，符合 Anthropic Claude API 标准
        success: boolean;
        tool_call_id: string;
    };
}

type MessageContent = TextContent | ToolCallContent | ToolResultContent;

interface ConvertedMessage {
    role: "user" | "assistant" | "tool";
    content: MessageContent[];
}

/**
 * 解析 SSE 格式响应
 */
function parseSSEResponse(responseText: string): SSEEvent[] {
    const lines = responseText.split("\n");
    const events: SSEEvent[] = [];

    for (const line of lines) {
        if (line.startsWith("data: ")) {
            try {
                const jsonStr = line.substring(6);
                const event = JSON.parse(jsonStr) as SSEEvent;
                events.push(event);
            } catch {
                // Skip invalid JSON lines
            }
        }
    }

    return events;
}

/**
 * 将 SSE 事件转换为标准消息格式
 */
export function convertResponseToMessages(
    userMessage: UserModelMessage,
    responseContent: string
): ConvertedMessage[] {
    const events = parseSSEResponse(responseContent);
    const messages: ConvertedMessage[] = [];

    // 调试日志：统计事件类型
    const eventTypeStats = new Map<string, number>();
    events.forEach(event => {
        const type = event.type || "unknown";
        eventTypeStats.set(type, (eventTypeStats.get(type) || 0) + 1);
    });
    console.log("[ResponseConverter] Event type statistics:", Object.fromEntries(eventTypeStats));
    console.log(`[ResponseConverter] Total events: ${events.length}`);

    // 1. 添加 user message
    // 始终转换为数组格式（Agent 要求 content 必须是数组）
    const userContent: MessageContent[] = [];

    if (typeof userMessage.content === "string") {
        // 字符串转换为数组格式
        userContent.push({
            type: "text",
            text: userMessage.content,
        });
    } else {
        // 数组格式，逐个转换为标准格式
        for (const part of userMessage.content) {
            if (part.type === "text") {
                userContent.push({
                    type: "text",
                    text: part.text,
                });
            }
            // 忽略 image 和 file 类型，因为目标格式只支持 text, tool_call, tool_result
        }
    }

    messages.push({
        role: "user",
        content: userContent,
    });

    // 2. 处理 assistant 和 tool 消息
    const assistantContent: MessageContent[] = [];
    let currentRole: "assistant" | "tool" = "assistant";

    for (const event of events) {
        const type = event.type || "";

        if (type === "text-delta" && event.text) {
            // text-delta: 合并到 assistant 消息
            if (currentRole === "tool") {
                // 如果之前是 tool，需要先保存 assistant 消息
                if (assistantContent.length > 0) {
                    messages.push({
                        role: "assistant",
                        content: [...assistantContent],
                    });
                    assistantContent.length = 0;
                }
                currentRole = "assistant";
            }

            // 查找是否已有 text content，如果有就追加
            const lastContent = assistantContent[assistantContent.length - 1];
            if (lastContent && lastContent.type === "text") {
                (lastContent as TextContent).text += event.text;
            } else {
                assistantContent.push({
                    type: "text",
                    text: event.text,
                });
            }
        } else if (type === "tool-call") {
            // tool-call: 添加到 assistant 消息
            if (currentRole === "tool") {
                // 如果之前是 tool，需要先保存消息
                if (assistantContent.length > 0) {
                    messages.push({
                        role: "assistant",
                        content: [...assistantContent],
                    });
                    assistantContent.length = 0;
                }
                currentRole = "assistant";
            }

            // 调试日志：检查字段完整性
            console.log("[ResponseConverter] tool-call event:", {
                hasToolName: !!event.toolName,
                hasToolCallId: !!event.toolCallId,
                hasInput: !!event.input,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
            });

            if (event.toolName && event.toolCallId && event.input) {
                console.log(`[ResponseConverter] ✅ Adding tool-call: ${event.toolName}`);
                assistantContent.push({
                    type: "tool_call",
                    tool_call: {
                        id: event.toolCallId,
                        name: event.toolName,
                        arguments: event.input as Record<string, unknown>,
                    },
                });
            } else {
                console.warn("[ResponseConverter] ⚠️ Skipped tool-call due to missing fields:", {
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    hasInput: !!event.input,
                });
            }
        } else if (type === "tool-result") {
            // tool-result: 需要切换到 tool role
            if (currentRole === "assistant" && assistantContent.length > 0) {
                // 保存之前的 assistant 消息
                messages.push({
                    role: "assistant",
                    content: [...assistantContent],
                });
                assistantContent.length = 0;
            }

            currentRole = "tool";

            // 调试日志：检查字段完整性
            console.log("[ResponseConverter] tool-result event:", {
                hasToolName: !!event.toolName,
                hasToolCallId: !!event.toolCallId,
                hasOutput: !!event.output,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
            });

            if (event.toolName && event.toolCallId) {
                console.log(`[ResponseConverter] ✅ Adding tool-result: ${event.toolName}`);

                // 将 content 序列化为字符串（符合 Anthropic Claude API 标准）
                const rawContent = event.output?.modelVisibleData?.data ?? null;
                const contentString = typeof rawContent === 'string'
                    ? rawContent
                    : JSON.stringify(rawContent);

                const toolResultContent: ToolResultContent = {
                    type: "tool_result",
                    tool_result: {
                        name: event.toolName,
                        content: contentString,
                        success: event.output?.success ?? false,
                        tool_call_id: event.toolCallId,
                    },
                };

                // tool-result 单独成为一条消息
                messages.push({
                    role: "tool",
                    content: [toolResultContent],
                });
            } else {
                console.warn("[ResponseConverter] ⚠️ Skipped tool-result due to missing fields:", {
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                });
            }
        } else if (type) {
            // 记录所有未处理的事件类型
            console.log(`[ResponseConverter] 🔍 Unhandled event type: "${type}"`, {
                hasText: !!event.text,
                hasToolName: !!event.toolName,
                hasToolCallId: !!event.toolCallId,
                keys: Object.keys(event),
            });
        }
    }

    // 3. 保存剩余的 assistant 消息
    if (assistantContent.length > 0) {
        messages.push({
            role: "assistant",
            content: assistantContent,
        });
    }

    // 调试日志：最终消息统计
    console.log("[ResponseConverter] Conversion complete:", {
        totalMessages: messages.length,
        messageRoles: messages.map(m => m.role),
        assistantToolCalls: messages
            .filter(m => m.role === "assistant")
            .reduce((count, m) => count + m.content.filter(c => c.type === "tool_call").length, 0),
        toolResults: messages.filter(m => m.role === "tool").length,
    });

    return messages;
}

/**
 * 用于调试：打印转换后的消息
 */
export function debugPrintMessages(messages: ConvertedMessage[]): void {
    console.log("=== Converted Messages ===");
    console.log(JSON.stringify(messages, null, 2));
}

/**
 * Voice Agent 响应格式
 */
interface VoiceAgentMessage {
    role: string;
    content?: string;
    tool_calls?: Array<{
        id: string;
        type?: string;
        function: {
            name: string;
            arguments: string | Record<string, unknown>;
        };
    }>;
    tool_call_id?: string;
}

interface VoiceAgentResponse {
    messages: VoiceAgentMessage[];
}

/**
 * 将 Voice Agent 的 JSON 响应转换为标准消息格式
 * Voice Agent 返回 { messages: [{role, content, tool_calls?, tool_call_id?}] }
 */
export function convertVoiceAgentResponseToMessages(
    userMessage: UserModelMessage,
    responseContent: string
): ConvertedMessage[] {
    const messages: ConvertedMessage[] = [];

    // 1. 添加 user message
    const userContent: MessageContent[] = [];
    if (typeof userMessage.content === "string") {
        userContent.push({ type: "text", text: userMessage.content });
    } else {
        for (const part of userMessage.content) {
            if (part.type === "text") {
                userContent.push({ type: "text", text: part.text });
            }
        }
    }
    messages.push({ role: "user", content: userContent });

    // 2. 解析 Voice Agent JSON 响应
    let voiceMessages: VoiceAgentMessage[];
    try {
        const data = JSON.parse(responseContent) as Record<string, unknown>;
        // 支持 { messages: [...] } 和 { data: { messages: [...] } } 两种结构
        voiceMessages = (
            (data.messages as VoiceAgentMessage[] | undefined)
            ?? ((data.data as Record<string, unknown> | undefined)?.messages as VoiceAgentMessage[] | undefined)
            ?? []
        );
    } catch {
        console.error("[VoiceAgentConverter] Failed to parse response JSON");
        return messages;
    }

    if (voiceMessages.length === 0) {
        console.warn("[VoiceAgentConverter] No messages found in response");
        return messages;
    }

    console.log(`[VoiceAgentConverter] Processing ${voiceMessages.length} messages`);

    // 3. 建立 tool_call_id → tool_name 映射
    const toolCallIdToName = new Map<string, string>();
    for (const msg of voiceMessages) {
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                toolCallIdToName.set(tc.id, tc.function.name);
            }
        }
    }

    // 4. 转换每条消息
    for (const msg of voiceMessages) {
        if (msg.role === "assistant") {
            const content: MessageContent[] = [];

            // 文本内容
            if (msg.content) {
                content.push({ type: "text", text: msg.content });
            }

            // tool_calls
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    let args: Record<string, unknown>;
                    if (typeof tc.function.arguments === "string") {
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { raw: tc.function.arguments };
                        }
                    } else {
                        args = tc.function.arguments;
                    }

                    content.push({
                        type: "tool_call",
                        tool_call: {
                            id: tc.id,
                            name: tc.function.name,
                            arguments: args,
                        },
                    });
                }
            }

            if (content.length > 0) {
                messages.push({ role: "assistant", content });
            }
        } else if (msg.role === "tool") {
            const toolCallId = msg.tool_call_id ?? "";
            const toolName = toolCallIdToName.get(toolCallId) ?? "";

            // 解析 tool content，提取 modelVisibleData（与 SSE 模式一致）
            let toolOutput: unknown = msg.content ?? "";
            let success = true;
            if (typeof msg.content === "string") {
                try {
                    const parsed = JSON.parse(msg.content) as Record<string, unknown>;
                    success = (parsed.success as boolean) ?? true;
                    toolOutput = (parsed as { modelVisibleData?: { data?: unknown } }).modelVisibleData?.data ?? parsed;
                } catch {
                    // 保持原始字符串
                }
            }

            const contentString = typeof toolOutput === "string"
                ? toolOutput
                : JSON.stringify(toolOutput);

            const content: MessageContent[] = [];
            content.push({
                type: "tool_result",
                tool_result: {
                    name: toolName,
                    content: contentString,
                    success,
                    tool_call_id: toolCallId,
                },
            });

            messages.push({ role: "tool", content });
        }
    }

    console.log("[VoiceAgentConverter] Conversion complete:", {
        totalMessages: messages.length,
        messageRoles: messages.map(m => m.role),
    });

    return messages;
}
