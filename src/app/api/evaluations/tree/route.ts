import { NextResponse } from "next/server";
import { fetchEvaluationTree } from "@/lib/evaluations/repository";

export async function GET() {
    try {
        const data = await fetchEvaluationTree();
        return NextResponse.json({ data });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Failed to load evaluations";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
