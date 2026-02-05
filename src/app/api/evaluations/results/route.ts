import { NextRequest, NextResponse } from "next/server";
import { saveEvaluationResult, getEvaluationResult } from "@/lib/evaluations/repository";
import type { EvaluationResultStatus } from "@/db";

/**
 * GET /api/evaluations/results?versionId=xxx&caseId=xxx
 *
 * 获取评估结果（包含完整的 responseContent）
 * 用于按需加载大型响应数据
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const versionId = searchParams.get("versionId");
        const caseId = searchParams.get("caseId");

        if (!versionId || !caseId) {
            return NextResponse.json(
                { error: "Missing required parameters: versionId, caseId" },
                { status: 400 }
            );
        }

        const result = await getEvaluationResult({ versionId, caseId });

        if (!result) {
            return NextResponse.json(
                { error: "Result not found" },
                { status: 404 }
            );
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error("Failed to get evaluation result:", error);

        const message = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { error: `Failed to get result: ${message}` },
            { status: 500 }
        );
    }
}

/**
 * POST /api/evaluations/results
 *
 * 保存前端运行的 case 结果到数据库
 * 每个 (versionId, caseId) 只保留最新的一条结果
 */
export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as {
            versionId: string;
            contextId: string;
            caseId: string;
            status: EvaluationResultStatus;
            responseContent: string;
            resultOverview?: string;
            score?: number;
            latencyMs?: number;
            startedAt?: string;
            completedAt?: string;
            error?: string;
        };

        const {
            versionId,
            contextId,
            caseId,
            status,
            responseContent,
            resultOverview,
            score,
            latencyMs,
            startedAt,
            completedAt,
            error,
        } = body;

        // 验证必需参数
        if (!versionId || !contextId || !caseId || !status || !responseContent) {
            return NextResponse.json(
                {
                    error: "Missing required fields: versionId, contextId, caseId, status, responseContent",
                },
                { status: 400 }
            );
        }

        await saveEvaluationResult({
            versionId,
            contextId,
            caseId,
            status,
            responseContent,
            resultOverview,
            score,
            latencyMs,
            startedAt: startedAt ? new Date(startedAt) : undefined,
            completedAt: completedAt ? new Date(completedAt) : undefined,
            error,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to save evaluation result:", error);

        const message = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { error: `Failed to save result: ${message}` },
            { status: 500 }
        );
    }
}
