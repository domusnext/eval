import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import("next").NextConfig} */
const nextConfig = {
    /* config options here */
    async rewrites() {
        return [
            {
                source: "/api/agent/:path*",
                destination: "http://localhost:8082/:path*",
            },
        ];
    },
};

if (process.env.NODE_ENV === "development") {
    initOpenNextCloudflareForDev();
}

export default nextConfig;
