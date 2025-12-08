import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { evaluationContexts } from "@/db/schema";
import { loadDefaultEnvironment } from "@/lib/evaluations/config-loader";
import { sql } from "drizzle-orm";

/**
 * POST /api/evaluations/contexts/sync-defaults
 * 批量更新已有 contexts 的 environment 和 headers
 *
 * Request body:
 * {
 *   "updateAll": true,           // 更新所有 contexts
 *   "contextIds": ["id1", "id2"] // 或者指定要更新的 context IDs
 * }
 */
export async function POST(request: NextRequest) {
    try {
        const body = (await request.json().catch(() => ({}))) as {
            updateAll?: boolean;
            contextIds?: string[];
        };

        // 加载默认配置
        const defaults = await loadDefaultEnvironment();

        const db = await getDb();
        const currentTimestamp = sql<number>`cast((julianday('now') - 2440587.5) * 86400000 as integer)`;

        let updatedCount = 0;

        if (body.updateAll) {
            // 更新所有 contexts
            const result = await db
                .update(evaluationContexts)
                .set({
                    environmentJson: JSON.stringify(defaults.environment),
                    headersJson: JSON.stringify(defaults.headers),
                    updatedAt: currentTimestamp,
                })
                .returning({ id: evaluationContexts.id });

            updatedCount = result.length;
        } else if (body.contextIds && body.contextIds.length > 0) {
            // 更新指定的 contexts
            for (const contextId of body.contextIds) {
                await db
                    .update(evaluationContexts)
                    .set({
                        environmentJson: JSON.stringify(defaults.environment),
                        headersJson: JSON.stringify(defaults.headers),
                        updatedAt: currentTimestamp,
                    })
                    .where(sql`${evaluationContexts.id} = ${contextId}`);
                updatedCount++;
            }
        } else {
            return NextResponse.json(
                {
                    error: "Please specify either 'updateAll: true' or provide 'contextIds' array",
                },
                { status: 400 },
            );
        }

        return NextResponse.json({
            data: {
                updatedCount,
                environment: defaults.environment,
                headers: defaults.headers,
            },
        });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "Failed to sync default configuration";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
