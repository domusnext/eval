import { NextResponse } from "next/server";
import { getDb, evaluationVersions, evaluationContexts, evaluationCases } from "@/db";
import { desc, asc } from "drizzle-orm";

/**
 * 简化版的 tree API，不包含评测结果（responseContent）
 * 用于诊断数据加载问题
 */
export async function GET() {
    try {
        const db = await getDb();

        // 只获取基本结构，不包含结果
        const versionRows = await db
            .select()
            .from(evaluationVersions)
            .orderBy(desc(evaluationVersions.createdAt));

        console.log("[Tree Simple] Found versions:", versionRows.length);

        const allContexts = await db
            .select()
            .from(evaluationContexts)
            .orderBy(asc(evaluationContexts.depth), asc(evaluationContexts.createdAt));

        console.log("[Tree Simple] Found contexts:", allContexts.length);

        const caseRows = await db
            .select()
            .from(evaluationCases)
            .orderBy(asc(evaluationCases.orderIndex), asc(evaluationCases.createdAt));

        console.log("[Tree Simple] Found cases:", caseRows.length);

        // 返回简化的数据（不包含评测结果）
        const simplifiedData = versionRows.map(v => ({
            id: v.id,
            label: v.label,
            contextCount: allContexts.length,
            caseCount: caseRows.filter(c =>
                allContexts.some(ctx => ctx.id === c.rootContextId)
            ).length
        }));

        return NextResponse.json({
            success: true,
            data: simplifiedData,
            message: "Simplified tree loaded successfully (without evaluation results)"
        });

    } catch (error) {
        console.error("[Tree Simple] Error:", error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
