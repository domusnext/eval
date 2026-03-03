import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/evaluations/run/voice-agent
 *
 * 服务端代理：转发 voice-agent 请求到外部 endpoint，避免浏览器 CORS 限制。
 * 前端将 targetUrl / headers / body 传入，本路由在服务端发起实际请求并返回结果。
 */
export async function POST(request: NextRequest) {
    try {
        const { targetUrl, headers, body } = (await request.json()) as {
            targetUrl: string;
            headers: Record<string, string>;
            body: unknown;
        };

        if (!targetUrl) {
            return NextResponse.json(
                { error: "Missing targetUrl" },
                { status: 400 },
            );
        }
        console.log("Proxying request to:", targetUrl, "with headers:", JSON.stringify(headers, null, 2), "and body:", JSON.stringify(body, null, 2));
        const upstream = await fetch(targetUrl, {
            method: "POST",
            headers: {
                ...headers,
                "User-Agent": request.headers.get("user-agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": request.headers.get("accept") || "application/json, text/plain, */*",
                "Accept-Language": request.headers.get("accept-language") || "en-US,en;q=0.9",
                "Accept-Encoding": request.headers.get("accept-encoding") || "gzip, deflate, br",
                "Origin": request.headers.get("origin") || "https://smart-domi.app",
                "Referer": request.headers.get("referer") || "https://smart-domi.app/"
            },
            body: JSON.stringify(body),
        });

        console.log("Received response from upstream with status:", upstream.status, "and headers:", JSON.stringify(Object.fromEntries(upstream.headers.entries()), null, 2));

        const contentType = upstream.headers.get("content-type") ?? "";
        if (!upstream.ok) {
            const errorText = await upstream.text().catch(() => "");
            return NextResponse.json(
                { error: errorText || `Upstream responded with ${upstream.status}` },
                { status: upstream.status },
            );
        }

        if (contentType.includes("application/json")) {
            const data = await upstream.json();
            return NextResponse.json(data);
        }

        // 非 JSON 响应原样返回
        const text = await upstream.text();
        return new NextResponse(text, {
            status: upstream.status,
            headers: { "Content-Type": contentType },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json(
            { error: `Proxy error: ${message}` },
            { status: 502 },
        );
    }
}
