import { NextRequest, NextResponse } from "next/server";
import { createEvaluationContext } from "@/lib/evaluations/repository";
import { readFile } from "fs/promises";
import { join } from "path";
import type { Environment } from "@/lib/evaluations/models";

// 读取默认配置
async function loadDefaultEnvironment(): Promise<{
    environment: Environment;
    headers: Record<string, string>;
}> {
    try {
        const configPath = join(process.cwd(), "default_environment.json");
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content) as {
            environment: Environment;
            headers: Record<string, string>;
        };
        return config;
    } catch (error) {
        console.warn("Failed to load default_environment.json, using empty defaults:", error);
        return {
            environment: {
                family_info: {},
                user_brief: {},
                chat_info: {},
            },
            headers: {},
        };
    }
}

export async function POST(request: NextRequest) {
    try {
        if (
            !request.headers.get("content-type")?.includes("application/json")
        ) {
            return NextResponse.json(
                { error: "Expected JSON body" },
                { status: 400 },
            );
        }

        const body = (await request.json().catch(() => ({}))) as {
            name?: string;
            description?: string | null;
        };

        // 加载默认配置
        const defaults = await loadDefaultEnvironment();

        const id = await createEvaluationContext({
            name: body?.name,
            description: body?.description ?? undefined,
            environment: defaults.environment,
            headers: defaults.headers,
        });

        return NextResponse.json({ data: { id } }, { status: 201 });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Failed to create context";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
