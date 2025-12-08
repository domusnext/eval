import type { Environment } from "@/lib/evaluations/models";
import { defaultConfig } from "./default-config";

/**
 * 加载默认配置
 *
 * 优先使用代码中嵌入的配置（defaultConfig），这样可以在 Cloudflare 等无文件系统的环境中正常工作。
 *
 * 如果需要在本地开发时动态修改配置，可以直接编辑 default-config.ts 文件。
 */
export async function loadDefaultEnvironment(): Promise<{
    environment: Environment;
    headers: Record<string, string>;
}> {
    try {
        // 使用代码内嵌的配置
        // 这种方式兼容 Cloudflare Workers/Pages 等无文件系统的环境
        return {
            environment: defaultConfig.environment,
            headers: defaultConfig.headers,
        };
    } catch (error) {
        console.error(
            "Failed to load default configuration:",
            error,
        );
        // 返回空配置作为最后的 fallback
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
