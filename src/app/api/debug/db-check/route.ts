import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET() {
    try {
        console.log("[DB Check] Starting database diagnostic...");

        // 1. Check if we can get Cloudflare context
        const { env } = await getCloudflareContext();
        console.log("[DB Check] Got Cloudflare context:", {
            hasEnv: !!env,
            envKeys: env ? Object.keys(env) : []
        });

        // 2. Check if D1 database binding exists
        const db = (env as any).eval_d1_db;
        console.log("[DB Check] D1 binding:", {
            hasDb: !!db,
            dbType: typeof db
        });

        if (!db) {
            return NextResponse.json({
                success: false,
                error: "D1 database binding 'eval_d1_db' not found",
                env: env ? Object.keys(env) : []
            }, { status: 500 });
        }

        // 3. Try to query database
        const result = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.log("[DB Check] Tables found:", result.results);

        // 4. Check if evaluations tables exist
        const tables = result.results.map((r: any) => r.name);
        const requiredTables = ['evaluation_versions', 'evaluation_contexts', 'evaluation_cases', 'evaluation_results'];
        const missingTables = requiredTables.filter(t => !tables.includes(t));

        // 5. Try to count data
        let counts = {};
        if (missingTables.length === 0) {
            const versionsResult = await db.prepare("SELECT COUNT(*) as count FROM evaluation_versions").all();
            const contextsResult = await db.prepare("SELECT COUNT(*) as count FROM evaluation_contexts").all();
            const casesResult = await db.prepare("SELECT COUNT(*) as count FROM evaluation_cases").all();
            const resultsResult = await db.prepare("SELECT COUNT(*) as count FROM evaluation_results").all();

            counts = {
                versions: versionsResult.results[0]?.count ?? 0,
                contexts: contextsResult.results[0]?.count ?? 0,
                cases: casesResult.results[0]?.count ?? 0,
                results: resultsResult.results[0]?.count ?? 0
            };
        }

        return NextResponse.json({
            success: true,
            tables,
            missingTables,
            counts,
            message: missingTables.length > 0
                ? "Database binding works but tables are missing. Run migrations with: npm run db:migrate:prod"
                : "Database is properly configured and has data"
        });

    } catch (error) {
        console.error("[DB Check] Error:", error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        }, { status: 500 });
    }
}
