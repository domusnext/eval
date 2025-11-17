import { NextRequest, NextResponse } from "next/server";
import { createEvaluationCase } from "@/lib/evaluations/repository";

type BatchCaseInput = {
    userMessage: string;
    evalRule: string;
};

/**
 * POST /api/evaluations/cases/batch
 *
 * 批量创建 evaluation cases
 */
export async function POST(request: NextRequest) {
    try {
        if (!request.headers.get("content-type")?.includes("application/json")) {
            return NextResponse.json(
                { error: "Expected JSON body" },
                { status: 400 },
            );
        }

        const body = (await request.json().catch(() => ({}))) as {
            contextId?: string;
            cases?: BatchCaseInput[];
        };

        const { contextId, cases } = body;

        if (!contextId || typeof contextId !== "string") {
            return NextResponse.json(
                { error: "Missing or invalid contextId" },
                { status: 400 },
            );
        }

        if (!Array.isArray(cases) || cases.length === 0) {
            return NextResponse.json(
                { error: "Missing or empty cases array" },
                { status: 400 },
            );
        }

        // 批量创建 cases
        const createdIds: string[] = [];
        const errors: { index: number; error: string }[] = [];

        for (let i = 0; i < cases.length; i++) {
            const caseData = cases[i];

            // 验证数据
            if (!caseData.userMessage || typeof caseData.userMessage !== "string") {
                errors.push({ index: i, error: "Missing or invalid userMessage" });
                continue;
            }

            try {
                // 生成 title：使用 userMessage 第一行，最多 50 字符
                const firstLine = caseData.userMessage.trim().split('\n')[0];
                const title = firstLine.length > 50
                    ? firstLine.substring(0, 50) + "..."
                    : firstLine;

                // 创建 case
                const caseId = await createEvaluationCase({
                    rootContextId: contextId,
                    title,
                    userMessage: {
                        role: "user",
                        content: caseData.userMessage.trim(),
                    },
                    evalRule: caseData.evalRule?.trim() || undefined,
                });

                createdIds.push(caseId);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "Unknown error";
                errors.push({ index: i, error: message });
            }
        }

        return NextResponse.json({
            success: true,
            created: createdIds.length,
            failed: errors.length,
            createdIds,
            errors: errors.length > 0 ? errors : undefined,
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to batch create cases";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
