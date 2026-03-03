import { NextRequest, NextResponse } from "next/server";
import { createChildContextFromCaseResult } from "@/lib/evaluations/repository";
import { convertResponseToMessages, convertVoiceAgentResponseToMessages } from "@/lib/evaluations/response-converter";
import type { UserModelMessage } from "@/lib/evaluations/types";

/**
 * POST /api/evaluations/contexts/[contextId]/save-result
 *
 * 从 Case 执行结果创建新的 Context，将 responseContent 转换后追加到 recent_messages
 */
export async function POST(
    request: NextRequest,
    { params }: { params: { contextId: string } }
) {
    try {
        const { contextId } = params;
        const body = (await request.json()) as {
            userMessage: UserModelMessage;
            responseContent: string;
            caseTitle?: string;
            mode?: string;
        };

        const { userMessage, responseContent, caseTitle, mode } = body;

        // 验证必需参数
        if (!userMessage || !responseContent) {
            return NextResponse.json(
                { error: "Missing required fields: userMessage, responseContent" },
                { status: 400 }
            );
        }

        // 1. 按 mode 选择转换器
        const newMessages = mode === "voice-agent"
            ? convertVoiceAgentResponseToMessages(userMessage, responseContent)
            : convertResponseToMessages(userMessage, responseContent);

        // 2. 创建子 Context
        const newContextId = await createChildContextFromCaseResult(
            contextId,
            newMessages,
            caseTitle
        );

        return NextResponse.json({
            success: true,
            newContextId,
            messagesAdded: newMessages.length,
        });
    } catch (error) {
        console.error("Failed to save result to context:", error);

        const message = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { error: `Failed to save result: ${message}` },
            { status: 500 }
        );
    }
}
