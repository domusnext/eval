import { NextResponse } from "next/server";
import { getDb, evaluationCases, evaluationContexts, evaluationResults, evaluationVersions } from "@/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/evaluations/debug/stats
 *
 * 查看数据库统计信息，用于诊断问题
 */
export async function GET() {
    try {
        const db = await getDb();

        // 统计各表记录数
        const [versionsCount] = await db.select({ count: sql<number>`count(*)` }).from(evaluationVersions);
        const [contextsCount] = await db.select({ count: sql<number>`count(*)` }).from(evaluationContexts);
        const [casesCount] = await db.select({ count: sql<number>`count(*)` }).from(evaluationCases);
        const [resultsCount] = await db.select({ count: sql<number>`count(*)` }).from(evaluationResults);

        // 获取最近10个cases的详细信息
        const recentCases = await db
            .select({
                id: evaluationCases.id,
                title: evaluationCases.title,
                rootContextId: evaluationCases.rootContextId,
                createdAt: evaluationCases.createdAt,
            })
            .from(evaluationCases)
            .orderBy(sql`${evaluationCases.createdAt} DESC`)
            .limit(10);

        return NextResponse.json({
            stats: {
                versions: versionsCount.count,
                contexts: contextsCount.count,
                cases: casesCount.count,
                results: resultsCount.count,
            },
            recentCases,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to get stats";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
