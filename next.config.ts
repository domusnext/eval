import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

/** @type {import("next").NextConfig} */
const nextConfig: NextConfig = {
    /* config options here */
    async rewrites() {
        return [
            {
                source: "/api/agent/:path*",
                destination: "http://localhost:8082/:path*",
            },
        ];
    },
    webpack: (config, { isServer }) => {
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
