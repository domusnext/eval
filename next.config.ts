import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import path from "path";

/** @type {import("next").NextConfig} */
const nextConfig: NextConfig = {
    /* config options here */
    async rewrites() {
        // 支持通过环境变量配置 agent 地址
        // 开发环境默认 localhost，生产环境可以配置为 ngrok 或其他地址
        const agentUrl = process.env.AGENT_BASE_URL || "http://localhost:8082";
        console.log("[Next.js] Agent proxy target:", agentUrl);
        return [
            {
                source: "/api/agent/:path*",
                destination: `${agentUrl}/:path*`,
            },
        ];
    },
    webpack: (config, { isServer }) => {
        if (isServer) {
            config.resolve = config.resolve || {};
            config.resolve.alias = {
                ...(config.resolve.alias || {}),
                recordrtc: path.resolve(__dirname, "src/lib/recorder/recordrtc.server-stub.ts"),
            } as typeof config.resolve.alias;
        }
        // 确保 Node.js 内置模块不会被打包到客户端
        if (!isServer) {
            config.resolve = config.resolve || {};
            config.resolve.fallback = config.resolve.fallback || {};
            config.resolve.fallback = {
                ...config.resolve.fallback,
                zlib: false,
                stream: false,
                buffer: false,
            };
        }
        return config;
    },
};

if (process.env.NODE_ENV === "development") {
    initOpenNextCloudflareForDev();
}

export default nextConfig;
