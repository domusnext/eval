import { NextRequest, NextResponse } from "next/server";
import {
    deleteEvaluationContext,
    updateEvaluationContext,
} from "@/lib/evaluations/repository";

type RouteParams = { params: { contextId: string } };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
    const contextId = params?.contextId;

    if (typeof contextId !== "string" || !contextId.length) {
        return NextResponse.json({ error: "Missing contextId" }, { status: 400 });
    }

    try {
        if (!request.headers.get("content-type")?.includes("application/json")) {
            return NextResponse.json(
                { error: "Expected JSON body" },
                { status: 400 },
            );
        }

        const body = (await request.json().catch(() => ({}))) as {
            name?: string;
            description?: string | null;
            params?: Record<string, unknown>;
            headers?: Record<string, string>;
        };

        await updateEvaluationContext(contextId, {
            name: body?.name,
            description: body?.description ?? undefined,
            params: body?.params ?? {},
            headers: body?.headers ?? {},
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to update context";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const contextId = params?.contextId;

    if (typeof contextId !== "string" || !contextId.length) {
        return NextResponse.json({ error: "Missing contextId" }, { status: 400 });
    }

    try {
        await deleteEvaluationContext(contextId);
        return NextResponse.json({ success: true });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to delete context";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
