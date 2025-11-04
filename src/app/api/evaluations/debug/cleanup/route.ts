import { NextResponse } from "next/server";
import { getDb, evaluationCases } from "@/db";
import { eq } from "drizzle-orm";

/**
 * DELETE /api/evaluations/debug/cleanup?contextId=xxx
 *
 * 清理指定context下的所有cases（用于修复批量导入问题）
 */
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const contextId = searchParams.get("contextId");

        if (!contextId) {
            return NextResponse.json(
                { error: "Missing contextId parameter" },
                { status: 400 }
            );
        }

        const db = await getDb();

        // 获取要删除的cases列表
        const casesToDelete = await db
            .select({ id: evaluationCases.id, title: evaluationCases.title })
            .from(evaluationCases)
            .where(eq(evaluationCases.rootContextId, contextId));

        // 删除所有cases（会级联删除关联的results）
        await db
            .delete(evaluationCases)
            .where(eq(evaluationCases.rootContextId, contextId));

        return NextResponse.json({
            success: true,
            deleted: casesToDelete.length,
            cases: casesToDelete,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to cleanup";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
