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
            rootContextId?: string;
            title?: string;
            description?: string | null;
        };
        if (!body?.rootContextId || typeof body.rootContextId !== "string") {
            return NextResponse.json(
                { error: "Missing rootContextId" },
                { status: 400 },
            );
        }
        const id = await createEvaluationCase({
            rootContextId: body.rootContextId,
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
