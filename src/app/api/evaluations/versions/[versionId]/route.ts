import { NextRequest, NextResponse } from "next/server";
import {
    deleteEvaluationVersion,
    updateEvaluationVersion,
} from "@/lib/evaluations/repository";

type RouteParams = { params: { versionId: string } };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
    const versionId = params?.versionId;

    if (typeof versionId !== "string" || !versionId.length) {
        return NextResponse.json({ error: "Missing versionId" }, { status: 400 });
    }

    try {
        const body = request.headers
            .get("content-type")
            ?.includes("application/json")
            ? ((await request.json()) as {
                  label?: string;
                  notes?: string | null;
                  agentBaseUrl?: string | null;
              })
            : {};

        await updateEvaluationVersion(versionId, {
            label: body?.label,
            notes: body?.notes ?? undefined,
            agentBaseUrl: body?.agentBaseUrl ?? undefined,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to update version";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
    const versionId = params?.versionId;

    if (typeof versionId !== "string" || !versionId.length) {
        return NextResponse.json({ error: "Missing versionId" }, { status: 400 });
    }

    try {
        await deleteEvaluationVersion(versionId);
        return NextResponse.json({ success: true });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to delete version";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
