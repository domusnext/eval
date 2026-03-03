// Cloudflare Workers bindings type declarations
// This file ensures CloudflareEnv has the correct bindings even when
// the auto-generated cloudflare-env.d.ts is not present (e.g. in CI).

declare namespace Cloudflare {
    interface Env {
        CLOUDFLARE_R2_URL: string;
        eval_r2_bucket: R2Bucket;
        eval_d1_db: D1Database;
        ASSETS: Fetcher;
    }
}

interface CloudflareEnv extends Cloudflare.Env {}
