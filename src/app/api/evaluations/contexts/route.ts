import { NextRequest, NextResponse } from "next/server";
import { createEvaluationContext } from "@/lib/evaluations/repository";

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
            name?: string;
            description?: string | null;
        };

        const id = await createEvaluationContext({
            name: body?.name,
            description: body?.description ?? undefined,
        });

        return NextResponse.json({ data: { id } }, { status: 201 });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to create context";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
