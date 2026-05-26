import { NextRequest, NextResponse } from "next/server";
import { createEvaluationVersion } from "@/lib/evaluations/repository";
import type { VersionMode } from "@/lib/evaluations/models";

export async function POST(request: NextRequest) {
    try {
        let payload: {
            label?: string;
            notes?: string;
            agentBaseUrl?: string;
            mode?: VersionMode;
        } = {};
        if (request.headers.get("content-type")?.includes("application/json")) {
            const body = (await request.json().catch(() => ({}))) as {
                label?: string;
                notes?: string | null;
                agentBaseUrl?: string | null;
                mode?: string | null;
            };
            payload = {
                label: body?.label,
                notes: body?.notes ?? undefined,
                agentBaseUrl: body?.agentBaseUrl ?? undefined,
                mode: (body?.mode as VersionMode) ?? undefined,
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
