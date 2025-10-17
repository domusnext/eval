import { NextRequest, NextResponse } from "next/server";
import { queueEvaluationRun } from "@/lib/evaluations/repository";

export async function POST(request: NextRequest) {
    try {
        if (
            !request.headers.get("content-type")?.includes("application/json")
        ) {
            return NextResponse.json(
                { error: "Expected JSON body" },
                { status: 400 },
            );
        }
        const body = (await request.json().catch(() => ({}))) as any;
        if (!body?.versionId || typeof body.versionId !== "string") {
            return NextResponse.json(
                { error: "Missing versionId" },
                { status: 400 },
            );
        }

        const { runId, caseCount } = await queueEvaluationRun({
            versionId: body.versionId,
            contextIds:
                Array.isArray(body?.contextIds) && body.contextIds.length
                    ? body.contextIds
                    : undefined,
            caseIds:
                Array.isArray(body?.caseIds) && body.caseIds.length
                    ? body.caseIds
                    : undefined,
            maxCasesPerRun: body?.maxCasesPerRun,
            concurrentRequests: body?.concurrentRequests,
        });

        return NextResponse.json({
            data: { runId, caseCount },
        });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Failed to run evaluations";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
