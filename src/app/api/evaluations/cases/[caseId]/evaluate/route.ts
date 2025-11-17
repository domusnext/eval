import { NextRequest, NextResponse } from "next/server";
import { evaluateResponse } from "@/lib/evaluations/ai-evaluator";
import { getDb } from "@/db";
import { evaluationCases, evaluationContexts, evaluationResults } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { decompressText, isCompressed } from "@/lib/evaluations/compression";

type RouteParams = {
    params: {
        caseId: string;
    };
};

/**
 * POST /api/evaluations/cases/[caseId]/evaluate
 *
 * 使用 AI 评估 case 的 response，生成 resultOverview 和 score
 */
export async function POST(
    request: NextRequest,
    { params }: RouteParams
) {
    const caseId = params?.caseId;
    if (typeof caseId !== "string" || !caseId.length) {
        return NextResponse.json(
            { error: "Missing caseId" },
            { status: 400 }
        );
    }

    try {
        const db = await getDb();

        // 1. 获取 case 信息
        const [caseRow] = await db
            .select()
            .from(evaluationCases)
            .where(eq(evaluationCases.id, caseId))
            .limit(1);

        if (!caseRow) {
            return NextResponse.json(
                { error: "Case not found" },
                { status: 404 }
            );
        }

        // 2. 如果没有 evalRule，使用默认评估规则
        const defaultEvalRule = "Evaluate whether the AI agent's response is reasonable, complete, and accurate. Consider: 1) Does it address the user's request? 2) Is the information accurate? 3) Is the response well-structured and clear?";
        const evalRule = caseRow.evalRule || defaultEvalRule;

        // 3. 获取对应的 context（用于 contextSummary）
        const [context] = await db
            .select()
            .from(evaluationContexts)
            .where(eq(evaluationContexts.id, caseRow.rootContextId))
            .limit(1);

        if (!context) {
            return NextResponse.json(
                { error: "Context not found" },
                { status: 404 }
            );
        }

        // 4. 获取最新的 evaluationResult（包含 responseContent）
        // 需要从请求中获取 versionId
        const body = (await request.json().catch(() => ({}))) as {
            versionId?: string;
        };

        if (!body.versionId) {
            return NextResponse.json(
                { error: "Missing versionId in request body" },
                { status: 400 }
            );
        }

        const [latestResult] = await db
            .select()
            .from(evaluationResults)
            .where(
                and(
                    eq(evaluationResults.caseId, caseId),
                    eq(evaluationResults.versionId, body.versionId)
                )
            )
            .orderBy(desc(evaluationResults.createdAt))
            .limit(1);

        if (!latestResult) {
            return NextResponse.json(
                { error: "No evaluation result found for this case" },
                { status: 404 }
            );
        }

        if (!latestResult.responseJson) {
            return NextResponse.json(
                { error: "No response content available to evaluate" },
                { status: 400 }
            );
        }

        // 解压 responseJson（向后兼容未压缩的数据）
        let responseContent: string;
        try {
            if (isCompressed(latestResult.responseJson)) {
                console.log("[Evaluate API] Decompressing response for AI evaluation...");
                responseContent = decompressText(latestResult.responseJson);
                console.log(`[Evaluate API] Decompressed: ${latestResult.responseJson.length}B → ${responseContent.length}B`);
            } else {
                console.log("[Evaluate API] Using uncompressed response (legacy data)");
                responseContent = latestResult.responseJson;
            }
        } catch (error) {
            console.error("[Evaluate API] Failed to decompress response:", error);
            return NextResponse.json(
                { error: "Failed to decompress response content" },
                { status: 500 }
            );
        }

        // 5. 调用 AI 评估（使用解压后的数据）
        console.log(`[Evaluate API] Evaluating case ${caseId}...`);
        let evaluation: { resultOverview: string; score: 0 | 1 };
        try {
            evaluation = await evaluateResponse(
                evalRule,
                responseContent,  // 使用解压后的内容
                context.contextSummary ?? undefined
            );
        } catch (evalError) {
            console.error("[Evaluate API] AI evaluation failed:", evalError);
            const errorMsg = evalError instanceof Error ? evalError.message : String(evalError);
            return NextResponse.json(
                { error: `AI evaluation failed: ${errorMsg}` },
                { status: 500 }
            );
        }

        // 6. 更新 evaluationResult
        await db
            .update(evaluationResults)
            .set({
                resultOverview: evaluation.resultOverview,
                score: evaluation.score,
            })
            .where(eq(evaluationResults.id, latestResult.id));

        console.log(
            `[Evaluate API] Evaluation saved successfully. Score: ${evaluation.score}`
        );

        return NextResponse.json({
            success: true,
            resultOverview: evaluation.resultOverview,
            score: evaluation.score,
        });
    } catch (error) {
        console.error("[Evaluate API] Error:", error);
        const message =
            error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { error: `Failed to evaluate: ${message}` },
            { status: 500 }
        );
    }
}
