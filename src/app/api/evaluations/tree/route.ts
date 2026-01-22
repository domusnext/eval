import { NextResponse } from "next/server";
import { fetchEvaluationTree } from "@/lib/evaluations/repository";

export async function GET() {
    try {
        console.log("[Tree API] Starting fetchEvaluationTree...");
        const data = await fetchEvaluationTree();
        console.log("[Tree API] Fetched data:", {
            versionCount: data.length,
            firstVersion: data[0] ? {
                id: data[0].id,
                label: data[0].label,
                rootContextsCount: data[0].rootContexts.length
            } : null
        });
        return NextResponse.json({ data });
    } catch (error) {
        console.error("[Tree API] Error fetching evaluation tree:", error);
        const message =
            error instanceof Error
                ? error.message
                : "Failed to load evaluations";
        const stack = error instanceof Error ? error.stack : undefined;
        return NextResponse.json({
            error: message,
            stack,
            hint: "Check /api/debug/db-check for database connectivity"
        }, { status: 500 });
    }
}
