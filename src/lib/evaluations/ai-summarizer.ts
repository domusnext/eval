/**
 * AI 总结工具
 * 使用 OpenRouter 调用 Gemini 来总结 context messages
 */

import type { Message } from "./models";

/**
 * 将消息数组格式化为可读的文本
 */
function formatMessagesForSummary(messages: Message[]): string {
    if (!messages || messages.length === 0) {
        return "No messages";
    }

    return messages
        .map((msg, index) => {
            const role = msg.role.toUpperCase();
            let content = "";

            // 处理不同类型的 content
            if (Array.isArray(msg.content)) {
                content = msg.content
                    .map((item: any) => {
                        if (typeof item === "string") {
                            return item;
                        }
                        if (item.type === "text" && item.text) {
                            return item.text;
                        }
                        if (item.type === "tool_use") {
                            return `[Tool Use: ${item.name}]`;
                        }
                        if (item.type === "tool_result") {
                            return `[Tool Result]`;
                        }
                        return "[Non-text content]";
                    })
                    .join("\n");
            } else if (typeof msg.content === "string") {
                content = msg.content;
            } else {
                content = JSON.stringify(msg.content);
            }

            return `Message ${index + 1} [${role}]:\n${content}`;
        })
        .join("\n\n---\n\n");
}

/**
 * 调用 Gemini API 生成 context summary
 */
export async function generateContextSummary(
    messages: Message[]
): Promise<string> {
    if (!messages || messages.length === 0) {
        console.log("[AI Summarizer] No messages to summarize");
        return "";
    }

    console.log(`[AI Summarizer] Generating summary for ${messages.length} messages...`);
    const formattedMessages = formatMessagesForSummary(messages);

    const prompt = `Please provide a concise summary of the following conversation messages. Focus on:
1. The main topics discussed
2. User's core intent: what does the user want AI to do
3. Key actions or decisions made
4. Current context or state. If AI give options or proposal, briefly list them.

- Keep the summary brief (2-4 sentences) and in the same language as the conversation.
- Keep your summary organized as such format:
    - **User's core intent**: 
    - **Key actions made**: 
    - **Current state**: 
- Conversation:
${formattedMessages}

Summary:`;

    try {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            throw new Error("OPENROUTER_API_KEY environment variable is not set");
        }

        const response = await fetch(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                    "HTTP-Referer": "https://eval.app", // OpenRouter 需要
                    "X-Title": "Eval App", // OpenRouter 需要
                },
                body: JSON.stringify({
                    model: 'google/gemini-3-flash-preview',
                    messages: [
                        {
                            role: "user",
                            content: prompt,
                        },
                    ],
                    stream: false,
                }),
                signal: AbortSignal.timeout(30_000),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[AI Summarizer] OpenRouter error:", response.status, errorText);
            throw new Error(
                `OpenRouter returned ${response.status}: ${errorText}`
            );
        }

        const data = (await response.json()) as {
            choices?: Array<{
                message?: {
                    content?: string;
                };
            }>;
        };

        if (
            data.choices &&
            data.choices.length > 0 &&
            data.choices[0].message?.content
        ) {
            const summary = data.choices[0].message.content.trim();
            console.log("[AI Summarizer] Successfully generated summary:", summary.substring(0, 100) + "...");
            return summary;
        }

        console.error("[AI Summarizer] No content in AI response");
        throw new Error("No content in AI response");
    } catch (error) {
        console.error("[AI Summarizer] Failed to generate context summary:", error);
        // 返回空字符串而不是抛出错误，避免影响主流程
        return "";
    }
}
