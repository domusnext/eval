import { NextRequest, NextResponse } from "next/server";
import { createEvaluationCase } from "@/lib/evaluations/repository";

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
        const body = (await request.json().catch(() => ({}))) as {
            contextId?: string;
            title?: string;
            description?: string | null;
        };
        if (!body?.contextId || typeof body.contextId !== "string") {
            return NextResponse.json(
                { error: "Missing contextId" },
                { status: 400 },
            );
        }
        const id = await createEvaluationCase({
            contextId: body.contextId,
            title: body?.title,
            description: body?.description ?? undefined,
        });
        return NextResponse.json({ data: { id } }, { status: 201 });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to create case";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
