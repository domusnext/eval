import { NextRequest, NextResponse } from "next/server";
import { generateContextSummary } from "@/lib/evaluations/ai-summarizer";
import { updateEvaluationContext } from "@/lib/evaluations/repository";
import { getDb } from "@/db";
import { evaluationContexts } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { Message } from "@/lib/evaluations/models";

type RouteParams = {
    params: {
        contextId: string;
    };
};

/**
 * POST /api/evaluations/contexts/[contextId]/generate-summary
 *
 * 为指定的 context 生成 AI 总结
 */
export async function POST(
    _request: NextRequest,
    { params }: RouteParams
) {
    const contextId = params?.contextId;
    if (typeof contextId !== "string" || !contextId.length) {
        return NextResponse.json(
            { error: "Missing contextId" },
            { status: 400 }
        );
    }

    try {
        const db = await getDb();

        // 1. 获取 context 和它的 resolved messages
        const [context] = await db
            .select()
            .from(evaluationContexts)
            .where(eq(evaluationContexts.id, contextId))
            .limit(1);

        if (!context) {
            return NextResponse.json(
                { error: "Context not found" },
                { status: 404 }
            );
        }

        // 2. 获取所有 contexts 用于解析完整消息历史
        const allContexts = await db.select().from(evaluationContexts);
        const contextMap = new Map(allContexts.map((ctx) => [ctx.id, ctx]));

        // 3. 递归解析获取完整消息
        const resolvedMessages = await resolveContextMessages(
            context,
            contextMap
        );

        if (!resolvedMessages || resolvedMessages.length === 0) {
            return NextResponse.json(
                { error: "No messages to summarize" },
                { status: 400 }
            );
        }

        // 4. 生成 AI 总结
        console.log(`[Generate Summary API] Generating summary for context ${contextId} with ${resolvedMessages.length} messages...`);
        const summary = await generateContextSummary(resolvedMessages);

        if (!summary) {
            return NextResponse.json(
                { error: "Failed to generate summary" },
                { status: 500 }
            );
        }

        // 5. 更新 context
        await updateEvaluationContext(contextId, {
            contextSummary: summary,
        });

        console.log(`[Generate Summary API] Summary generated and saved successfully`);

        return NextResponse.json({
            success: true,
            summary,
        });
    } catch (error) {
        console.error("[Generate Summary API] Error:", error);
        const message =
            error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { error: `Failed to generate summary: ${message}` },
            { status: 500 }
        );
    }
}

/**
 * 递归解析 context 的完整消息历史
 */
async function resolveContextMessages(
    context: typeof evaluationContexts.$inferSelect,
    contextMap: Map<string, typeof evaluationContexts.$inferSelect>
): Promise<Message[]> {
    const messages: Message[] = [];

    // 递归获取父节点的消息
    if (context.parentContextId) {
        const parent = contextMap.get(context.parentContextId);
        if (parent) {
            const parentMessages = await resolveContextMessages(
                parent,
                contextMap
            );
            messages.push(...parentMessages);
        }
    }

    // 添加当前节点的消息
    try {
        const recentMessages = JSON.parse(
            context.recentMessagesJson || "[]"
        ) as Message[];
        messages.push(...recentMessages);
    } catch (error) {
        console.error("Failed to parse recentMessagesJson:", error);
    }

    return messages;
}
