import { NextRequest, NextResponse } from "next/server";
import { duplicateEvaluationVersion } from "@/lib/evaluations/repository";

type RouteParams = { params: { versionId: string } };

export async function POST(_request: NextRequest, { params }: RouteParams) {
    const versionId = params?.versionId;

    if (typeof versionId !== "string" || !versionId.length) {
        return NextResponse.json({ error: "Missing versionId" }, { status: 400 });
    }

    try {
        const id = await duplicateEvaluationVersion(versionId);
        return NextResponse.json({ data: { id } }, { status: 201 });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Failed to duplicate version";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
