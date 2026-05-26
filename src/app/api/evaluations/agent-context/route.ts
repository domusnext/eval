import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DOMUS_SERVICE_BASE_URL = "https://smart-domi.app/api";

type AgentContextRequest = {
    headers?: Record<string, string>;
    domusServiceBaseUrl?: string;
};

type JwtPayload = {
    sub?: string;
    user_metadata?: {
        timezone?: string;
        device_id?: string;
    };
};

const normalizeBaseUrl = (value?: string) =>
    (value?.trim() || DEFAULT_DOMUS_SERVICE_BASE_URL).replace(/\/+$/, "");

const findHeader = (headers: Record<string, string>, name: string) => {
    const lowerName = name.toLowerCase();
    const entry = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === lowerName,
    );
    return entry?.[1]?.trim();
};

const decodeJwtPayload = (authorization?: string): JwtPayload => {
    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token) return {};
    const payload = token.split(".")[1];
    if (!payload) return {};

    try {
        const normalized = payload
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(Math.ceil(payload.length / 4) * 4, "=");
        return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    } catch {
        return {};
    }
};

const buildForwardHeaders = (
    inputHeaders: Record<string, string>,
    authorization: string,
    familyId: string,
    userId: string,
    timezone: string,
) => {
    const headers: Record<string, string> = {
        ...inputHeaders,
        Authorization: authorization,
        "Content-Type": "application/json",
        "X-Family-ID": familyId,
        "X-User-ID": userId,
        "X-Timezone": timezone,
    };

    return headers;
};

const readUpstreamJson = async (response: Response) => {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return { raw: text };
    }
};

const normalizeEnvironment = (environment: unknown) => {
    const normalized =
        environment && typeof environment === "object"
            ? { ...(environment as Record<string, unknown>) }
            : {};

    const chatInfo =
        normalized.chat_info && typeof normalized.chat_info === "object"
            ? { ...(normalized.chat_info as Record<string, unknown>) }
            : {};

    normalized.chat_info = {
        conversation_id:
            typeof chatInfo.conversation_id === "string"
                ? chatInfo.conversation_id
                : "",
        turn_id: typeof chatInfo.turn_id === "string" ? chatInfo.turn_id : "",
        user_ui_message_id:
            typeof chatInfo.user_ui_message_id === "string"
                ? chatInfo.user_ui_message_id
                : "",
        assistant_ui_message_id:
            typeof chatInfo.assistant_ui_message_id === "string"
                ? chatInfo.assistant_ui_message_id
                : "",
    };

    return normalized;
};

export async function POST(request: NextRequest) {
    try {
        const { headers = {}, domusServiceBaseUrl } =
            (await request.json()) as AgentContextRequest;

        const authorization = findHeader(headers, "Authorization");
        const familyId = findHeader(headers, "X-Family-ID");
        const jwtPayload = decodeJwtPayload(authorization);
        const userId = findHeader(headers, "X-User-ID") ?? jwtPayload.sub;
        const timezone =
            findHeader(headers, "X-Timezone") ??
            jwtPayload.user_metadata?.timezone ??
            "UTC";

        if (!authorization) {
            return NextResponse.json(
                { error: "Authorization header is required" },
                { status: 400 },
            );
        }
        if (!familyId) {
            return NextResponse.json(
                { error: "X-Family-ID header is required" },
                { status: 400 },
            );
        }
        if (!userId) {
            return NextResponse.json(
                { error: "X-User-ID header is required or must be present in JWT sub" },
                { status: 400 },
            );
        }

        const baseUrl = normalizeBaseUrl(domusServiceBaseUrl);
        const forwardHeaders = buildForwardHeaders(
            headers,
            authorization,
            familyId,
            userId,
            timezone,
        );

        const roleResponse = await fetch(
            `${baseUrl}/v1/families/${familyId}/my_role`,
            {
                method: "GET",
                headers: forwardHeaders,
            },
        );
        const roleJson = await readUpstreamJson(roleResponse);
        if (!roleResponse.ok || roleJson?.code !== 0) {
            return NextResponse.json(
                {
                    error: "Failed to fetch family role",
                    upstreamStatus: roleResponse.status,
                    upstream: roleJson,
                },
                { status: roleResponse.ok ? 502 : roleResponse.status },
            );
        }

        const roleId = roleJson.data?.role_id;
        if (!roleId) {
            return NextResponse.json(
                { error: "Family role response did not include role_id" },
                { status: 502 },
            );
        }

        const contextResponse = await fetch(
            `${baseUrl}/v1/voice-agent/agent-context`,
            {
                method: "POST",
                headers: forwardHeaders,
                body: JSON.stringify({
                    user_id: userId,
                    family_id: familyId,
                    role_id: roleId,
                    timezone,
                }),
            },
        );
        const contextJson = await readUpstreamJson(contextResponse);
        if (!contextResponse.ok || contextJson?.code !== 0) {
            return NextResponse.json(
                {
                    error: "Failed to fetch agent context",
                    upstreamStatus: contextResponse.status,
                    upstream: contextJson,
                },
                { status: contextResponse.ok ? 502 : contextResponse.status },
            );
        }

        return NextResponse.json({
            environment: normalizeEnvironment(contextJson.data?.environment),
            roleId,
            familyId,
            userId,
            timezone,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json(
            { error: `Agent context proxy error: ${message}` },
            { status: 502 },
        );
    }
}
