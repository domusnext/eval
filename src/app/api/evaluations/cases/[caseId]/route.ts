import { NextRequest, NextResponse } from "next/server";
import {
    deleteEvaluationCase,
    updateEvaluationCase,
} from "@/lib/evaluations/repository";

type RouteParams = {
    params: {
        caseId: string;
    };
};

export async function PATCH(
    request: NextRequest,
    { params }: RouteParams,
) {
    const caseId = params?.caseId;
    if (typeof caseId !== "string" || !caseId.length) {
        return NextResponse.json({ error: "Missing caseId" }, { status: 400 });
    }

    try {
        if (
            !request.headers.get("content-type")?.includes("application/json")
        ) {
            return NextResponse.json(
                { error: "Expected JSON body" },
                { status: 400 },
            );
        }

        const body = (await request.json().catch(() => ({}))) as {
            title?: string;
            description?: string | null;
            userMessage?: unknown;
            assistantMessage?: unknown;
        };

        await updateEvaluationCase(caseId, {
            title: body?.title,
            description: body?.description ?? undefined,
            userMessage: body?.userMessage as any,
            assistantMessage: body?.assistantMessage as any,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to update case";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(
    _request: NextRequest,
    { params }: RouteParams,
) {
    const caseId = params?.caseId;
    if (typeof caseId !== "string" || !caseId.length) {
        return NextResponse.json({ error: "Missing caseId" }, { status: 400 });
    }

    try {
        await deleteEvaluationCase(caseId);
        return NextResponse.json({ success: true });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to delete case";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
