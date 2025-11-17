/**
 * Development adapter for local Next.js dev server
 * Provides mock Cloudflare bindings for development
 */

export function getDevCloudflareContext() {
    // Check if we're in development mode
    if (process.env.NODE_ENV !== "production") {
        return {
            env: {
                eval_d1_db: null, // Will use getRequestContext in server components
                eval_r2_bucket: null,
            },
            cf: {},
            ctx: {
                waitUntil: () => {},
                passThroughOnException: () => {},
            },
        };
    }
    return null;
}
