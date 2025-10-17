import { NextRequest, NextResponse } from "next/server";
import { createEvaluationVersion } from "@/lib/evaluations/repository";

export async function POST(request: NextRequest) {
    try {
        let payload: Partial<{
            label: string;
            notes: string;
            agentBaseUrl: string;
        }> = {};
        if (request.headers.get("content-type")?.includes("application/json")) {
            const body = (await request.json().catch(() => ({}))) as {
            label?: string;
            notes?: string | null;
            agentBaseUrl?: string | null;
        };
            payload = {
                label: body?.label,
                notes: body?.notes ?? undefined,
                agentBaseUrl: body?.agentBaseUrl ?? undefined,
            };
        }
        const id = await createEvaluationVersion(payload);
        return NextResponse.json({ data: { id } }, { status: 201 });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to create version";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
