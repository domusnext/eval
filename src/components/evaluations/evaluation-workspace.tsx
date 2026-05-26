"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import {
    ChevronDown,
    ChevronRight,
    Clock,
    Database,
    Download,
    Play,
    Plus,
    RefreshCw,
    Save,
    Settings2,
    Sparkles,
    Square,
    Trash2,
    Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { ContextTreeNode } from "./context-tree-node";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import type {
    Environment,
    EvaluationCase,
    EvaluationContext,
    EvaluationVersion,
    RunSummary,
    VersionMode,
} from "@/lib/evaluations/models";
import { cn } from "@/lib/utils";
import { MessageBuilder } from "@/components/evaluations/message-builder";

type SelectedNode =
    | { type: "version" }
    | { type: "context"; contextId: string }
    | { type: "case"; contextId: string; caseId: string };

type RunSource =
    | "sidebar-selected"
    | "header-selected"
    | "context"
    | "case"
    | "version"
    | null;

type RunConfig = {
    concurrentRequests: number;
};

type RunTrigger =
    | { kind: "version"; versionId: string }
    | { kind: "context"; versionId: string; contextId: string }
    | { kind: "case"; versionId: string; contextId: string; caseId: string }
    | {
          kind: "selection";
          versionId: string;
          contextIds: string[];
          caseIds: string[];
      };

type CaseExecutionTarget = {
    context: EvaluationContext;
    testCase: EvaluationCase;
};

const DEFAULT_AGENT_BASE_URL = "/api/agent"; // Use Next.js proxy to avoid CORS
const AGENT_STREAM_PATH = "/agent/v1/chat/completion/stream";
const TRACE_ID_HEADER = "TraceId";

type StatusBadge = NonNullable<EvaluationCase["lastRunSummary"]>["status"];

const statusVariantMap: Record<
    StatusBadge,
    "default" | "secondary" | "destructive"
> = {
    succeeded: "default",
    pending: "secondary",
    running: "secondary",
    failed: "destructive",
    timeout: "destructive",
};

const statusLabelMap: Record<StatusBadge, string> = {
    succeeded: "✓",
    pending: "○",
    running: "●",
    failed: "✗",
    timeout: "⏱",
};

const cloneData = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const DEFAULT_EVAL_RULE =
    "Evaluate whether the AI agent's response is reasonable, complete, and accurate. Consider: 1) Does it address the user's request? 2) Is the information accurate? 3) Is the response well-structured and clear?";

// Request notification permission if not already granted
const requestNotificationPermission = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
        return false;
    }

    if (Notification.permission === "granted") {
        return true;
    }

    if (Notification.permission !== "denied") {
        const permission = await Notification.requestPermission();
        return permission === "granted";
    }

    return false;
};

// Show desktop notification
const showNotification = (
    title: string,
    body: string,
    onClick?: () => void,
) => {
    if (typeof window === "undefined" || !("Notification" in window)) {
        return;
    }

    if (Notification.permission === "granted") {
        const notification = new Notification(title, {
            body,
            icon: "/favicon.ico",
            badge: "/favicon.ico",
            requireInteraction: false,
            silent: false,
        });

        if (onClick) {
            notification.onclick = () => {
                window.focus();
                onClick();
                notification.close();
            };
        }

        // Auto close after 10 seconds
        setTimeout(() => notification.close(), 10000);
    }
};

const normalizeAgentBaseUrl = (baseUrl?: string | null): string => {
    if (!baseUrl || !baseUrl.trim()) {
        return DEFAULT_AGENT_BASE_URL;
    }
    return baseUrl.trim().replace(/\/+$/, "");
};

const toAgentMessageContent = (
    message: EvaluationCase["userMessage"],
): unknown[] => {
    if (typeof message.content === "string") {
        const trimmed = message.content.trim();
        if (!trimmed) {
            return [];
        }
        return [
            {
                type: "text",
                text: trimmed,
            },
        ];
    }
    return cloneData(message.content ?? []);
};

const createAgentRecentMessage = (
    message: EvaluationCase["userMessage"],
): Record<string, unknown> | null => {
    const content = toAgentMessageContent(message);
    if (!content.length) {
        return null;
    }
    const payload: Record<string, unknown> = {
        role: message.role,
        content,
    };
    if (
        message.providerOptions &&
        Object.keys(message.providerOptions).length > 0
    ) {
        payload["provider_options"] = cloneData(message.providerOptions);
    }
    return payload;
};

// Score calculation utilities
type ScoreStats = {
    averageScore: number | null;
    totalItems: number;
    scoredItems: number;
    scoreSum: number;
    passCount: number;
};

/**
 * 递归计算 Context 的得分统计
 * 计分逻辑：整体平均 = (所有子context得分总和 + 所有直属case得分总和) / (子context数 + case数)
 */
const calculateContextScore = (context: EvaluationContext): ScoreStats => {
    let totalItems = 0;
    let scoredItems = 0;
    let scoreSum = 0;
    let passCount = 0;

    // 1. 收集所有直属 cases 的得分
    if (context.cases && context.cases.length > 0) {
        context.cases.forEach((testCase) => {
            const score = testCase.lastRunSummary?.score;
            if (score !== undefined && score !== null) {
                totalItems += 1;
                scoredItems += 1;
                scoreSum += score;
                if (score === 1) {
                    passCount += 1;
                }
            } else {
                // Case exists but not scored yet
                totalItems += 1;
            }
        });
    }

    // 2. 递归收集所有子 contexts 的得分
    if (context.children && context.children.length > 0) {
        context.children.forEach((child) => {
            const childStats = calculateContextScore(child);
            totalItems += childStats.totalItems;
            scoredItems += childStats.scoredItems;
            scoreSum += childStats.scoreSum;
            passCount += childStats.passCount;
        });
    }

    // 3. 计算平均分
    const averageScore = scoredItems > 0 ? scoreSum / scoredItems : null;

    return {
        averageScore,
        totalItems,
        scoredItems,
        scoreSum,
        passCount,
    };
};

/**
 * 计算 Version 的总体得分统计
 */
const calculateVersionScore = (version: EvaluationVersion): ScoreStats => {
    let totalItems = 0;
    let scoredItems = 0;
    let scoreSum = 0;
    let passCount = 0;

    // 遍历所有根 contexts，递归累加统计
    version.rootContexts.forEach((context) => {
        const contextStats = calculateContextScore(context);
        totalItems += contextStats.totalItems;
        scoredItems += contextStats.scoredItems;
        scoreSum += contextStats.scoreSum;
        passCount += contextStats.passCount;
    });

    const averageScore = scoredItems > 0 ? scoreSum / scoredItems : null;

    return {
        averageScore,
        totalItems,
        scoredItems,
        scoreSum,
        passCount,
    };
};

/**
 * 格式化得分显示
 */
const formatScore = (score: number | null): string => {
    if (score === null) return "N/A";
    return score.toFixed(2);
};

/**
 * 格式化通过率显示
 */
const formatPassRate = (passCount: number, totalCount: number): string => {
    if (totalCount === 0) return "N/A";
    const rate = (passCount / totalCount) * 100;
    return `${rate.toFixed(0)}%`;
};

const buildAgentRequestBody = (
    environment: Environment | undefined,
    resolvedMessages: EvaluationContext["resolvedMessages"],
    userMessage: EvaluationCase["userMessage"],
): Record<string, unknown> => {
    const agentMessage = createAgentRecentMessage(userMessage);
    if (!agentMessage) {
        throw new Error("User message is empty.");
    }

    // 使用当前 Context 的完整 environment（已经包含了从父节点拷贝的所有配置）
    const envData = cloneData(environment ?? {}) as Record<string, unknown>;
    const chatInfo =
        envData.chat_info && typeof envData.chat_info === "object"
            ? (envData.chat_info as Record<string, unknown>)
            : {};
    envData.chat_info = {
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

    // 从 envData 中移除 recent_messages，因为要单独处理
    delete envData["recent_messages"];

    // 构建正确的请求格式
    // environment: 使用当前 Context 的完整 environment（创建时已从父节点深拷贝）
    // recent_messages: 使用 resolvedMessages（递归合并的完整消息历史）
    const payload: Record<string, unknown> = {
        environment: envData,
        recent_messages: [
            ...cloneData(resolvedMessages as unknown[]),
            agentMessage,
        ],
    };

    return payload;
};

const buildVoiceAgentRequestBody = (
    resolvedMessages: EvaluationContext["resolvedMessages"],
    userMessage: EvaluationCase["userMessage"],
): Record<string, unknown> => {
    // 将 resolvedMessages + userMessage 转为 OpenAI 兼容格式
    // { messages: [{role, content?, tool_calls?, tool_call_id?}] }
    const messages: Array<Record<string, unknown>> = [];

    for (const msg of resolvedMessages ?? []) {
        const role = msg.role;
        const contentParts = Array.isArray(msg.content) ? msg.content : [];

        if (role === "user") {
            // User message: 提取文本
            let text = "";
            for (const part of contentParts) {
                const typed = part as { type?: string; text?: string };
                if (typed.type === "text" && typed.text) {
                    text += typed.text;
                }
            }
            if (text) {
                messages.push({ role: "user", content: text });
            }
        } else if (role === "assistant") {
            // Assistant message: 提取文本 + tool_calls
            let text = "";
            const toolCalls: Array<{
                id: string;
                type: string;
                function: { name: string; arguments: string };
            }> = [];

            for (const part of contentParts) {
                const typed = part as {
                    type?: string;
                    text?: string;
                    tool_call?: {
                        id: string;
                        name: string;
                        arguments: unknown;
                    };
                };
                if (typed.type === "text" && typed.text) {
                    text += typed.text;
                } else if (typed.type === "tool_call" && typed.tool_call) {
                    toolCalls.push({
                        id: typed.tool_call.id,
                        type: "function",
                        function: {
                            name: typed.tool_call.name,
                            arguments:
                                typeof typed.tool_call.arguments === "string"
                                    ? typed.tool_call.arguments
                                    : JSON.stringify(typed.tool_call.arguments),
                        },
                    });
                }
            }

            const assistantMsg: Record<string, unknown> = { role: "assistant" };
            if (text) assistantMsg.content = text;
            if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
            if (text || toolCalls.length > 0) messages.push(assistantMsg);
        } else if (role === "tool") {
            // Tool message: 提取 tool_result
            for (const part of contentParts) {
                const typed = part as {
                    type?: string;
                    tool_result?: { tool_call_id: string; content: string };
                };
                if (typed.type === "tool_result" && typed.tool_result) {
                    messages.push({
                        role: "tool",
                        content: typed.tool_result.content,
                        tool_call_id: typed.tool_result.tool_call_id,
                    });
                }
            }
        }
    }

    // 添加当前 userMessage
    const userContent =
        typeof userMessage.content === "string"
            ? userMessage.content
            : (userMessage.content ?? [])
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("");

    if (userContent) {
        messages.push({ role: "user", content: userContent });
    }

    return { messages };
};

const buildAgentRequestHeaders = (
    headers: Record<string, string> | undefined,
    traceId: string,
): Record<string, string> => {
    const merged: Record<string, string> = {
        "Content-Type": "application/json",
    };
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (typeof value === "string" && value.length > 0) {
            merged[key] = value;
        }
    }
    const withUserId = ensureAgentUserIdHeader(merged);
    withUserId[TRACE_ID_HEADER] = traceId;
    return withUserId;
};

const RUN_CONFIG_STORAGE_KEY = "evaluation-run-config-v2";
const AGENT_ENVIRONMENT_STORAGE_PREFIX = "agent-version-environment";
const AGENT_HEADERS_STORAGE_PREFIX = "agent-version-headers";

const getAgentEnvironmentStorageKey = (versionId: string) =>
    `${AGENT_ENVIRONMENT_STORAGE_PREFIX}:${versionId}`;

const getAgentHeadersStorageKey = (versionId: string) =>
    `${AGENT_HEADERS_STORAGE_PREFIX}:${versionId}`;

const readLocalJson = <T,>(key: string, fallback: T): T => {
    if (typeof window === "undefined") return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
};

const writeLocalJson = (key: string, value: unknown) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
};

const getHeaderValue = (headers: Record<string, string>, name: string) => {
    const lowerName = name.toLowerCase();
    const entry = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === lowerName,
    );
    return entry?.[1] ?? "";
};

const normalizeAuthHeader = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}`;
};

const decodeJwtSubject = (authorization: string) => {
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    const payload = token.split(".")[1];
    if (!payload) return "";

    try {
        const normalized = payload
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(Math.ceil(payload.length / 4) * 4, "=");
        const decoded = JSON.parse(atob(normalized)) as { sub?: unknown };
        return typeof decoded.sub === "string" ? decoded.sub : "";
    } catch {
        return "";
    }
};

const ensureAgentUserIdHeader = (headers: Record<string, string>) => {
    if (getHeaderValue(headers, "X-User-ID")) return headers;
    const authorization = getHeaderValue(headers, "Authorization");
    const userId = authorization ? decodeJwtSubject(authorization) : "";
    if (!userId) return headers;
    return {
        ...headers,
        "X-User-ID": userId,
    };
};

const buildAgentHeadersFromFields = (
    auth: string,
    familyId: string,
    timezone: string,
) => {
    const headers: Record<string, string> = {};
    const authorization = normalizeAuthHeader(auth);
    if (authorization) headers.Authorization = authorization;
    if (familyId.trim()) headers["X-Family-ID"] = familyId.trim();
    if (timezone.trim()) headers["X-Timezone"] = timezone.trim();
    return ensureAgentUserIdHeader(headers);
};

interface EvaluationWorkspaceProps {
    initialVersions: EvaluationVersion[];
    className?: string;
}

export function EvaluationWorkspace({
    initialVersions,
    className,
}: EvaluationWorkspaceProps) {
    const [versionsState, setVersionsState] = useState<EvaluationVersion[]>(
        () => cloneData(initialVersions),
    );
    const [activeVersionId, setActiveVersionId] = useState<string | null>(
        initialVersions[0]?.id ?? null,
    );
    const [selectedNode, setSelectedNode] = useState<SelectedNode>(() =>
        initialVersions[0]?.rootContexts?.[0]
            ? {
                  type: "context",
                  contextId: initialVersions[0].rootContexts[0].id,
              }
            : { type: "version" },
    );
    const [checkedContextIds, setCheckedContextIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [checkedCaseIds, setCheckedCaseIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [runConfig, setRunConfig] = useState<RunConfig>({
        concurrentRequests: 5,
    });
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [mutatingKeys, setMutatingKeys] = useState<Set<string>>(
        () => new Set(),
    );
    const mutatingKeysRef = useRef<Set<string>>(new Set());
    const [isRunConfigDialogOpen, setRunConfigDialogOpen] = useState(false);
    const [isVersionDialogOpen, setVersionDialogOpen] = useState(false);
    const [isContextDialogOpen, setContextDialogOpen] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [runningSource, setRunningSource] = useState<RunSource>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const [caseDialogTarget, setCaseDialogTarget] = useState<{
        contextId: string;
        caseId: string;
    } | null>(null);
    const [isCaseDialogOpen, setCaseDialogOpen] = useState(false);
    const [isRunMenuOpen, setRunMenuOpen] = useState(false);
    const runMenuRef = useRef<HTMLDivElement | null>(null);

    const apiRequest = useCallback(
        async <T = unknown>(url: string, init?: RequestInit): Promise<T> => {
            const headers = new Headers(init?.headers ?? {});
            if (!headers.has("Content-Type")) {
                headers.set("Content-Type", "application/json");
            }

            const response = await fetch(url, {
                cache: "no-store",
                ...init,
                headers,
            });

            const text = await response.text();
            let json: unknown = undefined;
            if (text) {
                try {
                    json = JSON.parse(text);
                } catch {
                    // Ignore parse errors; JSON will remain undefined.
                }
            }

            if (!response.ok) {
                const errorMessage =
                    (json &&
                        typeof json === "object" &&
                        "error" in json &&
                        typeof (json as { error?: string }).error ===
                            "string" &&
                        (json as { error?: string }).error) ||
                    response.statusText ||
                    "Request failed";
                throw new Error(String(errorMessage));
            }

            return json as T;
        },
        [],
    );

    const withMutation = useCallback(
        async <T,>(
            key: string,
            fn: () => Promise<T>,
        ): Promise<T | undefined> => {
            if (mutatingKeysRef.current.has(key)) return undefined;
            mutatingKeysRef.current.add(key);
            setMutatingKeys(new Set(mutatingKeysRef.current));
            try {
                return await fn();
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "Operation failed";
                toast.error(message);
                return undefined;
            } finally {
                mutatingKeysRef.current.delete(key);
                setMutatingKeys(new Set(mutatingKeysRef.current));
            }
        },
        [],
    );

    const sanitizeSelections = useCallback((versions: EvaluationVersion[]) => {
        const validContexts = new Set<string>();
        const validCases = new Set<string>();

        const collectContextsAndCases = (context: EvaluationContext) => {
            validContexts.add(context.id);
            context.cases?.forEach((testCase) => {
                validCases.add(testCase.id);
            });
            context.children?.forEach(collectContextsAndCases);
        };

        versions.forEach((version) => {
            version.rootContexts.forEach(collectContextsAndCases);
        });

        setCheckedContextIds((prev) => {
            const next = new Set<string>();
            prev.forEach((id) => {
                if (validContexts.has(id)) {
                    next.add(id);
                }
            });
            return next;
        });

        setCheckedCaseIds((prev) => {
            const next = new Set<string>();
            prev.forEach((id) => {
                if (validCases.has(id)) {
                    next.add(id);
                }
            });
            return next;
        });
    }, []);

    const updateCaseRunSummary = useCallback(
        (
            versionId: string,
            contextId: string,
            caseId: string,
            summary: RunSummary,
        ) => {
            setVersionsState((prev) =>
                prev.map((version) => {
                    if (version.id !== versionId) return version;

                    // Recursive function to update case in any context (including children)
                    const updateContextTree = (
                        context: EvaluationContext,
                    ): EvaluationContext => {
                        // Update cases in current context
                        const updatedCases =
                            context.id === contextId
                                ? context.cases?.map((testCase) => {
                                      if (testCase.id !== caseId) {
                                          return testCase;
                                      }
                                      return {
                                          ...testCase,
                                          lastRunSummary: summary,
                                      };
                                  })
                                : context.cases;

                        // Recursively update children
                        const updatedChildren =
                            context.children.map(updateContextTree);

                        return {
                            ...context,
                            cases: updatedCases,
                            children: updatedChildren,
                        };
                    };

                    return {
                        ...version,
                        rootContexts:
                            version.rootContexts.map(updateContextTree),
                    };
                }),
            );
        },
        [setVersionsState],
    );

    const refreshTree = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const { data } = await apiRequest<{ data: EvaluationVersion[] }>(
                "/api/evaluations/tree",
            );
            const next = cloneData(data ?? []);
            setVersionsState(next);
            sanitizeSelections(next);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to refresh data";
            toast.error(message);
        } finally {
            setIsRefreshing(false);
        }
    }, [apiRequest, sanitizeSelections]);

    const isBusy = mutatingKeys.size > 0 || isRefreshing;

    // Request notification permission on component mount
    useEffect(() => {
        void requestNotificationPermission();
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const stored = window.localStorage.getItem(RUN_CONFIG_STORAGE_KEY);
            if (!stored) return;
            const parsed = JSON.parse(stored) as Partial<RunConfig>;
            setRunConfig((prev) => {
                const concurrent =
                    typeof parsed.concurrentRequests === "number" &&
                    Number.isFinite(parsed.concurrentRequests)
                        ? Math.max(1, Math.floor(parsed.concurrentRequests))
                        : prev.concurrentRequests;
                return {
                    concurrentRequests: concurrent,
                };
            });
        } catch {
            // ignore corrupted storage
        }
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(
            RUN_CONFIG_STORAGE_KEY,
            JSON.stringify(runConfig),
        );
    }, [runConfig]);

    useEffect(() => {
        if (!isRunMenuOpen) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (
                runMenuRef.current &&
                event.target instanceof Node &&
                !runMenuRef.current.contains(event.target)
            ) {
                setRunMenuOpen(false);
            }
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setRunMenuOpen(false);
            }
        };
        window.addEventListener("pointerdown", handlePointerDown);
        window.addEventListener("keydown", handleEscape);
        return () => {
            window.removeEventListener("pointerdown", handlePointerDown);
            window.removeEventListener("keydown", handleEscape);
        };
    }, [isRunMenuOpen]);

    useEffect(() => {
        if (isRunConfigDialogOpen) {
            setRunMenuOpen(false);
        }
    }, [isRunConfigDialogOpen]);

    useEffect(() => {
        setVersionsState(cloneData(initialVersions));
        sanitizeSelections(initialVersions);
    }, [initialVersions, sanitizeSelections]);
    const activeVersion = useMemo(() => {
        if (!activeVersionId) return undefined;
        return versionsState.find((version) => version.id === activeVersionId);
    }, [versionsState, activeVersionId]);
    const totalCaseCount = useMemo(() => {
        if (!activeVersion) return 0;
        return activeVersion.rootContexts.reduce(
            (acc, context) => acc + (context.cases?.length || 0),
            0,
        );
    }, [activeVersion]);

    useEffect(() => {
        if (!activeVersion) {
            const fallbackVersionId = versionsState[0]?.id ?? null;
            if (fallbackVersionId !== activeVersionId) {
                setActiveVersionId(fallbackVersionId);
            }
            setSelectedNode({ type: "version" });
            return;
        }

        setSelectedNode((current) => {
            if (current.type === "version") return current;
            const context = findContextById(current.contextId);
            if (!context) {
                const fallbackContext = activeVersion.rootContexts[0];
                return fallbackContext
                    ? { type: "context", contextId: fallbackContext.id }
                    : { type: "version" };
            }
            if (current.type === "case") {
                const caseExists = context.cases?.some(
                    (testCase) => testCase.id === current.caseId,
                );
                if (!caseExists) {
                    return context.cases?.[0]
                        ? {
                              type: "case",
                              contextId: context.id,
                              caseId: context.cases[0].id,
                          }
                        : { type: "context", contextId: context.id };
                }
            }
            return current;
        });
    }, [activeVersion, versionsState, activeVersionId]);

    // Helper function to recursively find a context by ID in the tree
    const findContextById = useCallback(
        (contextId: string): EvaluationContext | undefined => {
            if (!activeVersion) return undefined;

            const searchInTree = (
                contexts: EvaluationContext[],
            ): EvaluationContext | undefined => {
                for (const ctx of contexts) {
                    if (ctx.id === contextId) return ctx;
                    if (ctx.children && ctx.children.length > 0) {
                        const found = searchInTree(ctx.children);
                        if (found) return found;
                    }
                }
                return undefined;
            };

            return searchInTree(activeVersion.rootContexts);
        },
        [activeVersion],
    );

    const selectedContext =
        selectedNode.type === "context" || selectedNode.type === "case"
            ? findContextById(selectedNode.contextId)
            : undefined;

    const selectedCase =
        selectedNode.type === "case" && selectedContext
            ? selectedContext.cases?.find(
                  (testCase) => testCase.id === selectedNode.caseId,
              )
            : undefined;
    const selectedCaseId =
        selectedNode.type === "case" ? selectedNode.caseId : null;
    const caseDialogData = useMemo(() => {
        if (!caseDialogTarget) return undefined;
        const context = findContextById(caseDialogTarget.contextId);
        if (!context) return undefined;
        const testCase = context.cases?.find(
            (item) => item.id === caseDialogTarget.caseId,
        );
        if (!testCase) return undefined;
        return { context, testCase };
    }, [caseDialogTarget, findContextById]);

    useEffect(() => {
        if (!activeVersion) {
            setVersionDialogOpen(false);
            setContextDialogOpen(false);
            setCaseDialogOpen(false);
        }
    }, [activeVersion]);

    // 键盘快捷键：上下方向键在同一context的cases之间切换
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // 只在选中case时响应
            if (selectedNode.type !== "case") return;

            // 只在没有焦点在输入框时响应
            const activeElement = document.activeElement;
            if (
                activeElement instanceof HTMLInputElement ||
                activeElement instanceof HTMLTextAreaElement ||
                activeElement instanceof HTMLSelectElement
            ) {
                return;
            }

            // 上下方向键切换
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();

                // 找到当前case所在的context
                const findContextWithCase = (
                    contexts: EvaluationContext[],
                ): EvaluationContext | null => {
                    for (const ctx of contexts) {
                        if (ctx.id === selectedNode.contextId) {
                            return ctx;
                        }
                        if (ctx.children && ctx.children.length > 0) {
                            const found = findContextWithCase(ctx.children);
                            if (found) return found;
                        }
                    }
                    return null;
                };

                const context = activeVersion
                    ? findContextWithCase(activeVersion.rootContexts)
                    : null;

                if (!context || !context.cases || context.cases.length === 0)
                    return;

                const cases = context.cases;
                const currentIndex = cases.findIndex(
                    (c) => c.id === selectedNode.caseId,
                );

                if (currentIndex === -1) return;

                let newIndex: number;
                if (e.key === "ArrowUp") {
                    // 向上切换
                    newIndex =
                        currentIndex <= 0 ? cases.length - 1 : currentIndex - 1;
                } else {
                    // 向下切换
                    newIndex =
                        currentIndex >= cases.length - 1 ? 0 : currentIndex + 1;
                }

                const newCase = cases[newIndex];
                if (newCase) {
                    setSelectedNode({
                        type: "case",
                        contextId: context.id,
                        caseId: newCase.id,
                    });

                    // 聚焦并精确滚动到新选中的case
                    setTimeout(() => {
                        const caseButton = document.querySelector(
                            `[data-case-id="${newCase.id}"]`,
                        ) as HTMLElement;
                        if (caseButton) {
                            caseButton.focus({ preventScroll: true }); // 先聚焦但不滚动

                            // 检查元素是否在可视区域内
                            const rect = caseButton.getBoundingClientRect();
                            const container =
                                caseButton.closest(".overflow-y-auto");

                            if (container) {
                                const containerRect =
                                    container.getBoundingClientRect();

                                // 如果元素在视口上方，滚动刚好让它显示
                                if (rect.top < containerRect.top) {
                                    container.scrollBy({
                                        top: rect.top - containerRect.top - 8, // 8px padding
                                        behavior: "smooth",
                                    });
                                }
                                // 如果元素在视口下方，滚动刚好让它显示
                                else if (rect.bottom > containerRect.bottom) {
                                    container.scrollBy({
                                        top:
                                            rect.bottom -
                                            containerRect.bottom +
                                            8, // 8px padding
                                        behavior: "smooth",
                                    });
                                }
                            }
                        }
                    }, 0);
                }
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [selectedNode, activeVersion]);

    useEffect(() => {
        if (!selectedContext) {
            setContextDialogOpen(false);
        }
    }, [selectedContext]);

    useEffect(() => {
        if (!caseDialogTarget) return;
        const context = findContextById(caseDialogTarget.contextId);
        const caseExists = context?.cases?.some(
            (item) => item.id === caseDialogTarget.caseId,
        );
        if (!context || !caseExists) {
            if (!isCaseDialogOpen) {
                return;
            }
            setCaseDialogOpen(false);
            setCaseDialogTarget(null);
        }
    }, [caseDialogTarget, findContextById, isCaseDialogOpen]);

    const toggleContextChecked = (
        context: EvaluationContext,
        checked: boolean,
    ) => {
        setCheckedContextIds((prev) => {
            const next = new Set(prev);
            if (checked) {
                next.add(context.id);
            } else {
                next.delete(context.id);
            }
            return next;
        });

        setCheckedCaseIds((prev) => {
            const next = new Set(prev);
            context.cases?.forEach((testCase) => {
                if (checked) {
                    next.add(testCase.id);
                } else {
                    next.delete(testCase.id);
                }
            });
            return next;
        });
    };

    const toggleCaseChecked = (caseId: string, checked: boolean) => {
        setCheckedCaseIds((prev) => {
            const next = new Set(prev);
            if (checked) {
                next.add(caseId);
            } else {
                next.delete(caseId);
            }
            return next;
        });
    };

    const handleAddVersion = async () => {
        await withMutation("add-version", async () => {
            const { data } = await apiRequest<{ data: { id: string } }>(
                "/api/evaluations/versions",
                { method: "POST", body: JSON.stringify({}) },
            );
            // 先刷新树，加载新 version 的数据
            await refreshTree();
            // 再设置 active version，确保新 version 已经在状态中
            if (data?.id) {
                setActiveVersionId(data.id);
                setSelectedNode({ type: "version" });
            }
            toast.success("Created new version");
        });
    };

    const openCaseEditor = useCallback((contextId: string, caseId: string) => {
        setCaseDialogTarget({ contextId, caseId });
        setCaseDialogOpen(true);
    }, []);

    const handleDuplicateVersion = async (version: EvaluationVersion) => {
        await withMutation(`dup-version:${version.id}`, async () => {
            const { data } = await apiRequest<{ data: { id: string } }>(
                `/api/evaluations/versions/${version.id}/duplicate`,
                { method: "POST", body: JSON.stringify({}) },
            );
            if (data?.id) {
                setActiveVersionId(data.id);
                setSelectedNode({ type: "version" });
            }
            await refreshTree();
            toast.success("Duplicated version");
        });
    };

    const handleDeleteVersion = async (versionId: string) => {
        if (mutatingKeysRef.current.has(`del-version:${versionId}`)) return;

        // 获取当前version以显示信息
        const version = versionsState.find((v) => v.id === versionId);
        if (!version) return;

        // 添加确认对话框
        const contextCount = version.rootContexts.length;
        const caseCount = version.rootContexts.reduce(
            (acc, context) => acc + (context.cases?.length || 0),
            0,
        );

        let warningMessage = `Are you sure you want to delete the version "${version.label}"?`;

        if (contextCount > 0 || caseCount > 0) {
            warningMessage += `\n\nThis will also delete:`;
            if (contextCount > 0)
                warningMessage += `\n- ${contextCount} context(s)`;
            if (caseCount > 0) warningMessage += `\n- ${caseCount} case(s)`;
            warningMessage += `\n- All associated evaluation results`;
        }

        warningMessage += `\n\nThis action cannot be undone.`;

        const confirmed = window.confirm(warningMessage);

        if (!confirmed) {
            return;
        }

        await withMutation(`del-version:${versionId}`, async () => {
            await apiRequest(`/api/evaluations/versions/${versionId}`, {
                method: "DELETE",
            });
            if (activeVersionId === versionId) {
                setActiveVersionId(null);
            }
            setSelectedNode({ type: "version" });
            await refreshTree();
            toast.success("Deleted version");
        });
    };

    const handleUpdateVersion = async (
        versionId: string,
        updates: Partial<EvaluationVersion>,
    ) => {
        await withMutation(`update-version:${versionId}`, async () => {
            await apiRequest(`/api/evaluations/versions/${versionId}`, {
                method: "PATCH",
                body: JSON.stringify({
                    label: updates.label,
                    notes: updates.notes ?? null,
                    agentBaseUrl: updates.agentBaseUrl ?? null,
                    mode: updates.mode ?? undefined,
                }),
            });
            await refreshTree();
            toast.success("Saved version changes");
        });
    };

    const handleAddContext = async () => {
        if (!activeVersion) return;
        await withMutation("add-context", async () => {
            const { data } = await apiRequest<{ data: { id: string } }>(
                "/api/evaluations/contexts",
                {
                    method: "POST",
                    body: JSON.stringify({}),
                },
            );
            if (data?.id) {
                setSelectedNode({
                    type: "context",
                    contextId: data.id,
                });
            }
            await refreshTree();
            toast.success("Added new context");
        });
    };

    const handleUpdateContext = async (
        contextId: string,
        updates: Partial<EvaluationContext>,
    ) => {
        await withMutation(`update-context:${contextId}`, async () => {
            await apiRequest(`/api/evaluations/contexts/${contextId}`, {
                method: "PATCH",
                body: JSON.stringify({
                    name: updates.name,
                    description: updates.description ?? null,
                    contextSummary: updates.contextSummary ?? null,
                }),
            });
            await refreshTree();
            toast.success("Saved context changes");
        });
    };

    const handleSyncContextDefaults = async () => {
        await withMutation("sync-defaults", async () => {
            const response = await apiRequest<{
                data: { updatedCount: number };
            }>("/api/evaluations/contexts/sync-defaults", {
                method: "POST",
                body: JSON.stringify({ updateAll: true }),
            });

            await refreshTree();

            const updatedCount = response?.data?.updatedCount ?? 0;
            const label =
                updatedCount === 1
                    ? "Synced defaults to 1 context"
                    : `Synced defaults to ${updatedCount} contexts`;
            toast.success(label);
        });
    };

    const handleDeleteContext = async (context: EvaluationContext) => {
        if (mutatingKeysRef.current.has(`del-context:${context.id}`)) return;

        // 添加确认对话框
        const caseCount = context.cases?.length || 0;
        const childCount = context.children?.length || 0;
        let warningMessage = `Are you sure you want to delete the context "${context.name}"?`;

        if (caseCount > 0 || childCount > 0) {
            warningMessage += `\n\nThis will also delete:`;
            if (caseCount > 0) warningMessage += `\n- ${caseCount} case(s)`;
            if (childCount > 0)
                warningMessage += `\n- ${childCount} child context(s) and their cases`;
        }

        warningMessage += `\n\nThis action cannot be undone.`;

        const confirmed = window.confirm(warningMessage);

        if (!confirmed) {
            return;
        }

        await withMutation(`del-context:${context.id}`, async () => {
            await apiRequest(`/api/evaluations/contexts/${context.id}`, {
                method: "DELETE",
            });
            setCheckedContextIds((prev) => {
                const next = new Set(prev);
                next.delete(context.id);
                return next;
            });
            setCheckedCaseIds((prev) => {
                const next = new Set(prev);
                context.cases?.forEach((testCase) => next.delete(testCase.id));
                return next;
            });
            setSelectedNode({ type: "version" });
            await refreshTree();
            toast.success("Deleted context");
        });
    };

    const handleAddCase = async (contextId: string) => {
        await withMutation(`add-case:${contextId}`, async () => {
            const { data } = await apiRequest<{ data: { id: string } }>(
                "/api/evaluations/cases",
                {
                    method: "POST",
                    body: JSON.stringify({ rootContextId: contextId }),
                },
            );
            if (data?.id) {
                setCaseDialogTarget({ contextId, caseId: data.id });
            }
            await refreshTree();
            if (data?.id) {
                setSelectedNode({
                    type: "case",
                    contextId,
                    caseId: data.id,
                });
                setCaseDialogOpen(true);
            }
            toast.success("Added new case");
        });
    };

    const handleUpdateCase = async (
        contextId: string,
        caseId: string,
        updates: Partial<EvaluationCase>,
    ) => {
        await withMutation(`update-case:${caseId}`, async () => {
            await apiRequest(`/api/evaluations/cases/${caseId}`, {
                method: "PATCH",
                body: JSON.stringify({
                    title: updates.title,
                    description: updates.description ?? null,
                    userMessage: updates.userMessage,
                    evalRule: updates.evalRule,
                }),
            });
            await refreshTree();
            toast.success("Saved case changes");
        });
    };

    const handleDeleteCase = async (
        contextId: string,
        testCase: EvaluationCase,
    ) => {
        if (mutatingKeysRef.current.has(`del-case:${testCase.id}`)) return;

        // 添加确认对话框
        const confirmed = window.confirm(
            `Are you sure you want to delete the case "${testCase.title}"?\n\nThis action cannot be undone.`,
        );

        if (!confirmed) {
            return;
        }

        await withMutation(`del-case:${testCase.id}`, async () => {
            await apiRequest(`/api/evaluations/cases/${testCase.id}`, {
                method: "DELETE",
            });
            setCheckedCaseIds((prev) => {
                const next = new Set(prev);
                next.delete(testCase.id);
                return next;
            });
            setSelectedNode({ type: "context", contextId });
            await refreshTree();
            toast.success("Deleted case");
        });
    };

    const gatherCasesForRun = (trigger: RunTrigger): CaseExecutionTarget[] => {
        if (!activeVersion) return [];

        const targetedCases = new Map<string, CaseExecutionTarget>();

        // Helper: Recursively collect all contexts including children
        const getAllContexts = (
            contexts: EvaluationContext[],
        ): EvaluationContext[] => {
            const result: EvaluationContext[] = [];
            for (const ctx of contexts) {
                result.push(ctx);
                if (ctx.children && ctx.children.length > 0) {
                    result.push(...getAllContexts(ctx.children));
                }
            }
            return result;
        };

        const allContexts = getAllContexts(activeVersion.rootContexts);

        const addContextCases = (
            context?: EvaluationContext,
            options: { includeChildren?: boolean } = {},
        ) => {
            if (!context) return;
            context.cases?.forEach((testCase) => {
                targetedCases.set(testCase.id, { context, testCase });
            });
            if (options.includeChildren && context.children?.length) {
                context.children.forEach((childContext) =>
                    addContextCases(childContext, options),
                );
            }
        };

        const addSpecificCase = (contextId: string, caseId: string) => {
            const context = findContextById(contextId);
            if (!context) return;
            const testCase = context.cases?.find(
                (candidate) => candidate.id === caseId,
            );
            if (testCase) {
                targetedCases.set(testCase.id, { context, testCase });
            }
        };

        switch (trigger.kind) {
            case "version": {
                allContexts.forEach((context) => {
                    context.cases?.forEach((testCase) => {
                        targetedCases.set(testCase.id, { context, testCase });
                    });
                });
                break;
            }
            case "context": {
                addContextCases(findContextById(trigger.contextId), {
                    includeChildren: true,
                });
                break;
            }
            case "case": {
                addSpecificCase(trigger.contextId, trigger.caseId);
                break;
            }
            case "selection": {
                if (trigger.contextIds.length) {
                    trigger.contextIds.forEach((contextId) => {
                        addContextCases(findContextById(contextId));
                    });
                }
                if (trigger.caseIds.length) {
                    trigger.caseIds.forEach((caseId) => {
                        allContexts.forEach((context) => {
                            const testCase = context.cases?.find(
                                (candidate) => candidate.id === caseId,
                            );
                            if (testCase) {
                                targetedCases.set(testCase.id, {
                                    context,
                                    testCase,
                                });
                            }
                        });
                    });
                }
                break;
            }
        }

        return Array.from(targetedCases.values());
    };

    const runCases = async (
        trigger: RunTrigger,
        friendlyLabel: string,
        source: RunSource,
    ) => {
        // If already running, abort the current run
        if (isRunning && abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsRunning(false);
            setRunningSource(null);
            return;
        }

        if (!activeVersion) {
            toast.error("Select a version before running cases");
            return;
        }
        const targets = gatherCasesForRun(trigger);
        if (!targets.length) {
            toast.error("No cases available to run for the selected scope");
            return;
        }

        if (mutatingKeysRef.current.has("run-cases")) return;

        // Create new AbortController for this run
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        mutatingKeysRef.current.add("run-cases");
        setMutatingKeys(new Set(mutatingKeysRef.current));
        setIsRunning(true);
        setRunningSource(source);

        let loadingToastId: string | undefined;

        try {
            const versionId = activeVersion.id;
            const versionMode: VersionMode = activeVersion.mode ?? "agent";
            const agentEnvironment =
                versionMode === "agent"
                    ? readLocalJson<Environment>(
                          getAgentEnvironmentStorageKey(versionId),
                          {},
                      )
                    : {};
            const agentHeaders =
                versionMode === "agent"
                    ? readLocalJson<Record<string, string>>(
                          getAgentHeadersStorageKey(versionId),
                          {},
                      )
                    : {};
            const agentEndpoint =
                versionMode === "voice-agent"
                    ? normalizeAgentBaseUrl(activeVersion.agentBaseUrl)
                    : `${normalizeAgentBaseUrl(activeVersion.agentBaseUrl)}${AGENT_STREAM_PATH}`;

            const casesToRun = targets;

            const concurrency = Math.min(
                Math.max(1, runConfig.concurrentRequests),
                casesToRun.length,
            );

            const runId =
                typeof crypto !== "undefined" && "randomUUID" in crypto
                    ? crypto.randomUUID()
                    : `eval-run-${Date.now()}-${Math.random()
                          .toString(16)
                          .slice(2)}`;

            const errors: { title: string; message: string }[] = [];
            let successCount = 0;
            let failureCount = 0;

            loadingToastId = toast.loading(
                `Running ${casesToRun.length} case(s) for ${friendlyLabel}...`,
            );

            const executeSingleCase = async (
                target: CaseExecutionTarget,
                index: number,
            ) => {
                const { context, testCase } = target;
                const startedAt = performance.now();

                updateCaseRunSummary(versionId, context.id, testCase.id, {
                    status: "running",
                });

                const traceId = `${runId}-${index + 1}-${Date.now()}`;

                try {
                    const headers = buildAgentRequestHeaders(
                        versionMode === "agent" ? agentHeaders : {},
                        traceId,
                    );

                    if (versionMode === "voice-agent") {
                        const token = localStorage.getItem(
                            `voice-agent-token:${activeVersion.id}`,
                        );
                        if (token) {
                            // 支持用户填入 "Bearer xxx" 或直接填 "xxx"
                            headers["Authorization"] = token.startsWith(
                                "Bearer ",
                            )
                                ? token
                                : `Bearer ${token}`;
                        }
                    }

                    let requestBody: Record<string, unknown>;
                    if (versionMode === "voice-agent") {
                        requestBody = buildVoiceAgentRequestBody(
                            context.resolvedMessages,
                            testCase.userMessage,
                        );
                    } else {
                        requestBody = buildAgentRequestBody(
                            agentEnvironment,
                            context.resolvedMessages,
                            testCase.userMessage,
                        );
                    }

                    let response: Response;
                    try {
                        if (versionMode === "voice-agent") {
                            // Voice Agent: 通过服务端代理避免 CORS
                            response = await fetch(
                                "/api/evaluations/run/voice-agent",
                                {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                        targetUrl: agentEndpoint,
                                        headers,
                                        body: requestBody,
                                    }),
                                    signal: abortController.signal,
                                },
                            );
                        } else {
                            response = await fetch(agentEndpoint, {
                                method: "POST",
                                body: JSON.stringify(requestBody),
                                headers,
                                signal: abortController.signal,
                            });
                        }
                    } catch (fetchError) {
                        // Check if this was an abort
                        if (
                            fetchError instanceof Error &&
                            fetchError.name === "AbortError"
                        ) {
                            throw fetchError;
                        }
                        throw new Error(
                            `Failed to connect to agent at ${agentEndpoint}. ` +
                                `Please ensure the agent service is running. ` +
                                `Error: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
                        );
                    }

                    if (!response.ok) {
                        const errorText = await response.text().catch(() => "");
                        throw new Error(
                            errorText ||
                                `Agent responded with status ${response.status}`,
                        );
                    }

                    let responseContent = "";

                    if (versionMode === "voice-agent") {
                        // Voice Agent: JSON 响应
                        const jsonResponse = await response.json();
                        responseContent = JSON.stringify(jsonResponse);
                    } else {
                        // SSE Agent: 流式读取
                        const reader = response.body?.getReader();
                        if (!reader) {
                            throw new Error(
                                "No response body reader available from agent.",
                            );
                        }

                        const decoder = new TextDecoder();
                        let done = false;
                        while (!done) {
                            const { value, done: readerDone } =
                                await reader.read();
                            if (value) {
                                const chunk = decoder.decode(value, {
                                    stream: !readerDone,
                                });
                                responseContent += chunk;
                            }
                            done = readerDone;
                        }
                        // Final flush of decoder
                        responseContent += decoder.decode();
                    }

                    // ========== 前端诊断：分析响应 ==========
                    if (versionMode !== "voice-agent") {
                        console.log(
                            `[Case Execution Debug] Analyzing responseContent for case: ${testCase.title}`,
                        );
                        const lines = responseContent.split("\n");
                        const eventTypes = new Map<string, number>();
                        let toolCallEvents = 0;
                        let toolResultEvents = 0;

                        for (const line of lines) {
                            if (line.startsWith("data: ")) {
                                try {
                                    const event = JSON.parse(
                                        line.substring(6),
                                    ) as any;
                                    const type = event.type || "unknown";
                                    eventTypes.set(
                                        type,
                                        (eventTypes.get(type) || 0) + 1,
                                    );

                                    if (type.toLowerCase().includes("tool")) {
                                        if (
                                            type.includes("call") ||
                                            type.includes("use")
                                        ) {
                                            toolCallEvents++;
                                            console.log(
                                                `[Case Execution Debug] Tool Call Event:`,
                                                {
                                                    type,
                                                    hasToolName:
                                                        !!event.toolName,
                                                    hasToolCallId:
                                                        !!event.toolCallId,
                                                    hasInput: !!event.input,
                                                    toolName: event.toolName,
                                                },
                                            );
                                        } else if (type.includes("result")) {
                                            toolResultEvents++;
                                            console.log(
                                                `[Case Execution Debug] Tool Result Event:`,
                                                {
                                                    type,
                                                    hasToolName:
                                                        !!event.toolName,
                                                    hasToolCallId:
                                                        !!event.toolCallId,
                                                    toolName: event.toolName,
                                                },
                                            );
                                        }
                                    }
                                } catch {
                                    // Skip invalid JSON
                                }
                            }
                        }

                        console.log(
                            "[Case Execution Debug] SSE Response Summary:",
                            {
                                totalLines: lines.length,
                                uniqueEventTypes: Array.from(eventTypes.keys()),
                                eventTypeCounts: Object.fromEntries(eventTypes),
                                toolCallEvents,
                                toolResultEvents,
                            },
                        );

                        if (toolCallEvents === 0 && toolResultEvents > 0) {
                            console.warn(
                                "[Case Execution Debug] ISSUE DETECTED: No tool-call events but tool-result events exist!",
                            );
                        }
                    }
                    // ========== 诊断结束 ==========

                    const durationMs = Math.round(
                        performance.now() - startedAt,
                    );
                    const completedAt = new Date().toISOString();

                    successCount += 1;

                    // 更新前端状态
                    updateCaseRunSummary(versionId, context.id, testCase.id, {
                        status: "succeeded",
                        durationMs,
                        completedAt,
                        responseContent,
                    });

                    // 保存到数据库
                    let savedSuccessfully = false;
                    try {
                        await apiRequest("/api/evaluations/results", {
                            method: "POST",
                            body: JSON.stringify({
                                versionId,
                                contextId: context.id,
                                caseId: testCase.id,
                                status: "succeeded",
                                responseContent,
                                latencyMs: durationMs,
                                startedAt: new Date(startedAt).toISOString(),
                                completedAt,
                            }),
                        });
                        savedSuccessfully = true;
                        console.log(
                            `✅ [SaveResult] Case ${testCase.id} result saved successfully`,
                        );
                    } catch (saveError) {
                        console.error(
                            "❌ [SaveResult] Failed to save result:",
                            saveError,
                        );

                        // 保存失败：保留 responseContent 以便前端仍能展示
                        updateCaseRunSummary(
                            versionId,
                            context.id,
                            testCase.id,
                            {
                                status: "succeeded",
                                durationMs,
                                completedAt,
                                responseContent,
                            },
                        );

                        // 计算响应大小并显示警告
                        const responseSizeKB = Math.round(
                            responseContent.length / 1024,
                        );
                        const errorMsg =
                            saveError instanceof Error
                                ? saveError.message
                                : String(saveError);

                        toast.error(
                            `Failed to save case result (${responseSizeKB}KB). ${errorMsg}. ` +
                                "Evaluation skipped to maintain data consistency.",
                            { duration: 6000 },
                        );
                    }

                    // 只有保存成功才执行评估
                    if (savedSuccessfully) {
                        console.log(
                            `[Auto-evaluate] Evaluating case ${testCase.id}...`,
                        );
                        try {
                            const evalResponse = await apiRequest(
                                `/api/evaluations/cases/${testCase.id}/evaluate`,
                                {
                                    method: "POST",
                                    body: JSON.stringify({ versionId }),
                                },
                            );

                            const evalResult = evalResponse as {
                                resultOverview?: string;
                                score?: number;
                            };

                            // 更新前端状态显示评估结果
                            if (
                                evalResult.resultOverview !== undefined &&
                                evalResult.score !== undefined
                            ) {
                                updateCaseRunSummary(
                                    versionId,
                                    context.id,
                                    testCase.id,
                                    {
                                        status: "succeeded",
                                        durationMs,
                                        completedAt,
                                        responseContent,
                                        resultOverview:
                                            evalResult.resultOverview,
                                        score: evalResult.score,
                                    },
                                );
                                console.log(
                                    `[Auto-evaluate] Evaluation complete. Score: ${evalResult.score}`,
                                );
                            }
                        } catch (evalError) {
                            console.error(
                                `[Auto-evaluate] Failed to evaluate case ${testCase.id}:`,
                                evalError,
                            );
                            // 评估失败不影响主流程，只记录错误
                        }
                    }
                } catch (error) {
                    const durationMs = Math.round(
                        performance.now() - startedAt,
                    );
                    const completedAt = new Date().toISOString();
                    failureCount += 1;
                    const message =
                        error instanceof Error ? error.message : String(error);
                    errors.push({ title: testCase.title, message });

                    // 更新前端状态
                    updateCaseRunSummary(versionId, context.id, testCase.id, {
                        status: "failed",
                        durationMs,
                        completedAt,
                    });

                    // 保存到数据库
                    try {
                        await apiRequest("/api/evaluations/results", {
                            method: "POST",
                            body: JSON.stringify({
                                versionId,
                                contextId: context.id,
                                caseId: testCase.id,
                                status: "failed",
                                responseContent: "", // 失败时没有响应内容
                                latencyMs: durationMs,
                                startedAt: new Date(startedAt).toISOString(),
                                completedAt,
                                error: message,
                            }),
                        });
                    } catch (saveError) {
                        console.error(
                            "Failed to save result to database:",
                            saveError,
                        );
                    }

                    console.error(
                        `Failed to run case "${testCase.title}":`,
                        error,
                    );
                }
            };

            let cursor = 0;
            const workers = Array.from({ length: concurrency }, async () => {
                while (true) {
                    // Check if aborted
                    if (abortController.signal.aborted) {
                        break;
                    }

                    const currentIndex = cursor;
                    cursor += 1;
                    if (currentIndex >= casesToRun.length) {
                        break;
                    }
                    await executeSingleCase(
                        casesToRun[currentIndex],
                        currentIndex,
                    );
                }
            });

            await Promise.all(workers);

            if (loadingToastId) {
                toast.dismiss(loadingToastId);
                loadingToastId = undefined;
            }

            // Show desktop notification when all cases are completed
            const totalCases = casesToRun.length;
            let notificationTitle = "";
            let notificationBody = "";

            if (successCount && !failureCount) {
                notificationTitle = "✅ Evaluation Complete";
                notificationBody = `All ${successCount} case(s) for ${friendlyLabel} completed successfully!`;
                toast.success(
                    `Completed ${successCount} case(s) for ${friendlyLabel}.`,
                );
            } else if (!successCount && failureCount) {
                notificationTitle = "❌ Evaluation Failed";
                notificationBody = `Failed to run ${failureCount} case(s) for ${friendlyLabel}.`;
                toast.error(
                    `Failed to run ${failureCount} case(s) for ${friendlyLabel}.`,
                );
            } else if (successCount && failureCount) {
                notificationTitle = "⚠️ Evaluation Complete with Issues";
                notificationBody = `${successCount} succeeded, ${failureCount} failed for ${friendlyLabel}.`;
                toast(
                    `Completed ${successCount} case(s) with ${failureCount} failure(s) for ${friendlyLabel}.`,
                );
            }

            // Show desktop notification
            if (notificationTitle) {
                showNotification(notificationTitle, notificationBody, () => {
                    // Focus the window when notification is clicked
                    window.focus();
                });
            }

            if (errors.length) {
                console.groupCollapsed(
                    `[Evaluation run] ${errors.length} failure(s)`,
                );
                errors.forEach((entry) => {
                    console.error(`${entry.title}: ${entry.message}`);
                });
                console.groupEnd();
            }
        } catch (error) {
            // Check if this was an abort
            if (error instanceof Error && error.name === "AbortError") {
                toast("Run stopped by user", { duration: 3000 });
                return;
            }
            if (loadingToastId) {
                toast.dismiss(loadingToastId);
                loadingToastId = undefined;
            }
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to run evaluations";
            toast.error(message);
        } finally {
            mutatingKeysRef.current.delete("run-cases");
            setMutatingKeys(new Set(mutatingKeysRef.current));
            setIsRunning(false);
            setRunningSource(null);
            abortControllerRef.current = null;
        }
    };

    const contextSelectionState = (context: EvaluationContext) => {
        const totalCases = context.cases?.length || 0;
        const selectedCases =
            context.cases?.filter((testCase) => checkedCaseIds.has(testCase.id))
                .length || 0;
        if (checkedContextIds.has(context.id)) return true;
        if (selectedCases > 0 && selectedCases < totalCases)
            return "indeterminate";
        if (selectedCases > 0 && totalCases === 0) return true;
        return selectedCases > 0 ? true : false;
    };

    const selectedContextCount = checkedContextIds.size;
    const selectedCaseCount = checkedCaseIds.size;
    const canRunSelection = selectedContextCount > 0 || selectedCaseCount > 0;

    return (
        <div
            className={cn(
                "flex h-full min-h-[560px] w-full overflow-hidden rounded-2xl border bg-white shadow-sm",
                className,
            )}
        >
            <aside className="flex flex-col w-[420px] border-r bg-slate-50">
                <div className="border-b p-4 space-y-3 flex-shrink-0">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                                Version
                            </div>
                            <Select
                                value={activeVersionId ?? undefined}
                                onValueChange={(nextId) =>
                                    setActiveVersionId(nextId)
                                }
                            >
                                <SelectTrigger className="mt-1 w-full justify-between">
                                    <SelectValue placeholder="Select version" />
                                </SelectTrigger>
                                <SelectContent>
                                    {versionsState.map((version) => (
                                        <SelectItem
                                            key={version.id}
                                            value={version.id}
                                        >
                                            {version.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <Button
                            size="icon"
                            variant="outline"
                            disabled={isBusy}
                            onClick={handleAddVersion}
                            aria-label="Add version"
                        >
                            <Plus className="size-4" />
                        </Button>
                    </div>
                    <div className="flex items-center justify-between">
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full justify-center"
                            disabled={!activeVersion || isBusy}
                            onClick={() => {
                                if (activeVersion) {
                                    handleDuplicateVersion(activeVersion);
                                } else {
                                    toast.error("No version selected");
                                }
                            }}
                        >
                            Duplicate Version
                        </Button>
                    </div>
                    <Separator />
                    <div className="flex items-center justify-between">
                        <Button
                            size="sm"
                            className="w-full justify-center"
                            variant={
                                isRunning &&
                                runningSource === "sidebar-selected"
                                    ? "destructive"
                                    : "default"
                            }
                            onClick={() => {
                                if (!activeVersion) {
                                    toast.error("No version selected");
                                    return;
                                }
                                runCases(
                                    {
                                        kind: "selection",
                                        versionId: activeVersion.id,
                                        contextIds:
                                            Array.from(checkedContextIds),
                                        caseIds: Array.from(checkedCaseIds),
                                    },
                                    "selected scopes",
                                    "sidebar-selected",
                                );
                            }}
                            disabled={
                                !activeVersion ||
                                (!selectedContextCount &&
                                    !selectedCaseCount &&
                                    !isRunning) ||
                                (isBusy && runningSource !== "sidebar-selected")
                            }
                        >
                            {isRunning &&
                            runningSource === "sidebar-selected" ? (
                                <>
                                    <Square className="mr-2 size-4" />
                                    Stop
                                </>
                            ) : (
                                <>
                                    <Play className="mr-2 size-4" />
                                    Run Selected
                                </>
                            )}
                        </Button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                            Contexts & Cases
                        </h3>
                        <Button
                            size="icon"
                            variant="ghost"
                            onClick={handleAddContext}
                            disabled={!activeVersion || isBusy}
                            aria-label="Add context"
                        >
                            <Plus className="size-4" />
                        </Button>
                    </div>
                    <div className="space-y-1">
                        {activeVersion?.rootContexts.map((context) => (
                            <div
                                key={context.id}
                                className="rounded-lg border bg-white shadow-xs overflow-hidden"
                            >
                                <ContextTreeNode
                                    context={context}
                                    selectedNode={selectedNode}
                                    onSelectNode={setSelectedNode}
                                    checkedCaseIds={checkedCaseIds}
                                    onToggleCaseChecked={toggleCaseChecked}
                                    level={0}
                                    isRootContext={true}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </aside>

            <section className="flex-1 overflow-y-auto p-6 space-y-6">
                {activeVersion ? (
                    <>
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <h2 className="text-xl font-semibold text-slate-900">
                                    {activeVersion.label}
                                </h2>
                                <p className="text-sm text-slate-500">
                                    {activeVersion.rootContexts.length} context
                                    {activeVersion.rootContexts.length === 1
                                        ? ""
                                        : "s"}{" "}
                                    · {totalCaseCount} case
                                    {totalCaseCount === 1 ? "" : "s"}
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="relative" ref={runMenuRef}>
                                    <div className="inline-flex overflow-hidden rounded-md border bg-white shadow-sm">
                                        <Button
                                            size="sm"
                                            variant={
                                                isRunning &&
                                                runningSource ===
                                                    "header-selected"
                                                    ? "destructive"
                                                    : "default"
                                            }
                                            className="rounded-none rounded-l-md"
                                            disabled={
                                                (!canRunSelection &&
                                                    !isRunning) ||
                                                !activeVersion ||
                                                (isBusy &&
                                                    runningSource !==
                                                        "header-selected")
                                            }
                                            onClick={() => {
                                                if (
                                                    !activeVersion ||
                                                    (!canRunSelection &&
                                                        !isRunning)
                                                ) {
                                                    return;
                                                }
                                                void runCases(
                                                    {
                                                        kind: "selection",
                                                        versionId:
                                                            activeVersion.id,
                                                        contextIds:
                                                            Array.from(
                                                                checkedContextIds,
                                                            ),
                                                        caseIds:
                                                            Array.from(
                                                                checkedCaseIds,
                                                            ),
                                                    },
                                                    "selected scopes",
                                                    "header-selected",
                                                );
                                            }}
                                        >
                                            {isRunning &&
                                            runningSource ===
                                                "header-selected" ? (
                                                <>
                                                    <Square className="mr-2 size-4" />
                                                    Stop
                                                </>
                                            ) : (
                                                <>
                                                    <Play className="mr-2 size-4" />
                                                    Run selected
                                                </>
                                            )}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="default"
                                            className="rounded-none rounded-r-md border-l border-white/20 px-2"
                                            disabled={!activeVersion || isBusy}
                                            onClick={() => {
                                                if (!activeVersion || isBusy)
                                                    return;
                                                setRunMenuOpen((prev) => !prev);
                                            }}
                                        >
                                            <ChevronDown className="size-4" />
                                        </Button>
                                    </div>
                                    {isRunMenuOpen ? (
                                        <div className="absolute right-0 z-10 mt-2 w-48 overflow-hidden rounded-md border bg-white shadow-lg">
                                            <button
                                                type="button"
                                                className="flex w-full items-center justify-between px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100"
                                                disabled={isBusy}
                                                onClick={() => {
                                                    if (!activeVersion) return;
                                                    setRunMenuOpen(false);
                                                    void runCases(
                                                        {
                                                            kind: "version",
                                                            versionId:
                                                                activeVersion.id,
                                                        },
                                                        `version ${activeVersion.label}`,
                                                        "version",
                                                    );
                                                }}
                                            >
                                                Run version
                                                <Play className="size-3.5 text-slate-400" />
                                            </button>
                                            <button
                                                type="button"
                                                className="flex w-full items-center justify-between px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100"
                                                disabled={
                                                    !canRunSelection || isBusy
                                                }
                                                onClick={() => {
                                                    if (
                                                        !activeVersion ||
                                                        !canRunSelection
                                                    ) {
                                                        return;
                                                    }
                                                    setRunMenuOpen(false);
                                                    void runCases(
                                                        {
                                                            kind: "selection",
                                                            versionId:
                                                                activeVersion.id,
                                                            contextIds:
                                                                Array.from(
                                                                    checkedContextIds,
                                                                ),
                                                            caseIds:
                                                                Array.from(
                                                                    checkedCaseIds,
                                                                ),
                                                        },
                                                        "selected scopes",
                                                        "header-selected",
                                                    );
                                                }}
                                            >
                                                Run selected
                                                <Play className="size-3.5 text-slate-400" />
                                            </button>
                                            <button
                                                type="button"
                                                className="flex w-full items-center justify-between px-3 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100"
                                                onClick={() => {
                                                    setRunMenuOpen(false);
                                                    setRunConfigDialogOpen(
                                                        true,
                                                    );
                                                }}
                                            >
                                                Edit config
                                                <Settings2 className="size-3.5 text-slate-400" />
                                            </button>
                                        </div>
                                    ) : null}
                                </div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isBusy}
                                    onClick={handleSyncContextDefaults}
                                >
                                    <RefreshCw className="mr-2 size-4" />
                                    Sync defaults
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!activeVersion || isBusy}
                                    onClick={() => setVersionDialogOpen(true)}
                                >
                                    Edit version
                                </Button>
                            </div>
                        </div>

                        {selectedNode.type === "version" ? (
                            <VersionSummary
                                version={activeVersion}
                                isBusy={isBusy}
                                isRunning={isRunning}
                                onEdit={() => setVersionDialogOpen(true)}
                                onDelete={() =>
                                    handleDeleteVersion(activeVersion.id)
                                }
                                onRun={() =>
                                    runCases(
                                        {
                                            kind: "version",
                                            versionId: activeVersion.id,
                                        },
                                        `version ${activeVersion.label}`,
                                        "version",
                                    )
                                }
                            />
                        ) : null}

                        {selectedNode.type === "context" && selectedContext ? (
                            <ContextSummary
                                context={selectedContext}
                                isBusy={isBusy}
                                isRunning={isRunning}
                                runningSource={runningSource}
                                onEdit={() => {
                                    if (!selectedContext) return;
                                    setContextDialogOpen(true);
                                }}
                                onRun={() =>
                                    runCases(
                                        {
                                            kind: "context",
                                            versionId: activeVersion.id,
                                            contextId: selectedContext.id,
                                        },
                                        `context ${selectedContext.name}`,
                                        "context",
                                    )
                                }
                                onDelete={() =>
                                    handleDeleteContext(selectedContext)
                                }
                                onAddCase={() =>
                                    handleAddCase(selectedContext.id)
                                }
                                onRunCase={(caseId, label) =>
                                    runCases(
                                        {
                                            kind: "case",
                                            versionId: activeVersion.id,
                                            contextId: selectedContext.id,
                                            caseId,
                                        },
                                        `case ${label}`,
                                        "case",
                                    )
                                }
                                onEditCase={(caseId) =>
                                    openCaseEditor(selectedContext.id, caseId)
                                }
                                onSelectCase={(caseId) =>
                                    setSelectedNode({
                                        type: "case",
                                        contextId: selectedContext.id,
                                        caseId,
                                    })
                                }
                                selectedCaseId={selectedCaseId}
                                onRefresh={refreshTree}
                            />
                        ) : null}

                        {selectedCase && selectedContext ? (
                            <CaseSummary
                                context={selectedContext}
                                testCase={selectedCase}
                                isBusy={isBusy}
                                isRunning={isRunning}
                                runningSource={runningSource}
                                onRun={() =>
                                    runCases(
                                        {
                                            kind: "case",
                                            versionId: activeVersion.id,
                                            contextId: selectedContext.id,
                                            caseId: selectedCase.id,
                                        },
                                        `case ${selectedCase.title}`,
                                        "case",
                                    )
                                }
                                onDelete={() =>
                                    handleDeleteCase(
                                        selectedContext.id,
                                        selectedCase,
                                    )
                                }
                                onEdit={() =>
                                    openCaseEditor(
                                        selectedContext.id,
                                        selectedCase.id,
                                    )
                                }
                                onRefresh={refreshTree}
                                versionId={activeVersion.id}
                                onUpdateCase={handleUpdateCase}
                                versionMode={activeVersion.mode ?? "agent"}
                            />
                        ) : null}
                    </>
                ) : (
                    <EmptyState />
                )}
            </section>
            <RunConfigDialog
                open={isRunConfigDialogOpen}
                onOpenChange={setRunConfigDialogOpen}
                runConfig={runConfig}
                setRunConfig={setRunConfig}
            />
            {activeVersion ? (
                <VersionEditDialog
                    open={isVersionDialogOpen}
                    onOpenChange={setVersionDialogOpen}
                    version={activeVersion}
                    isBusy={isBusy}
                    onSave={(updates) =>
                        handleUpdateVersion(activeVersion.id, updates)
                    }
                    onDelete={() => handleDeleteVersion(activeVersion.id)}
                />
            ) : null}
            {selectedContext ? (
                <ContextEditDialog
                    open={isContextDialogOpen}
                    onOpenChange={setContextDialogOpen}
                    context={selectedContext}
                    isBusy={isBusy}
                    onSave={(updates) =>
                        handleUpdateContext(selectedContext.id, updates)
                    }
                />
            ) : null}
            {caseDialogData ? (
                <CaseEditDialog
                    open={isCaseDialogOpen}
                    onOpenChange={(open) => {
                        setCaseDialogOpen(open);
                        if (!open) {
                            setCaseDialogTarget(null);
                        }
                    }}
                    context={caseDialogData.context}
                    testCase={caseDialogData.testCase}
                    isBusy={isBusy}
                    onSave={(updates) =>
                        handleUpdateCase(
                            caseDialogData.context.id,
                            caseDialogData.testCase.id,
                            updates,
                        )
                    }
                />
            ) : null}
        </div>
    );
}

function RunConfigDialog({
    open,
    onOpenChange,
    runConfig,
    setRunConfig,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    runConfig: RunConfig;
    setRunConfig: Dispatch<SetStateAction<RunConfig>>;
}) {
    const handleNumberChange = (key: keyof RunConfig, rawValue: string) => {
        const normalized = rawValue.trim();
        if (!normalized) {
            setRunConfig((prev) => ({
                ...prev,
                [key]: 1,
            }));
            return;
        }
        const parsed = Number.parseInt(normalized, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
            return;
        }
        setRunConfig((prev) => ({
            ...prev,
            [key]: parsed,
        }));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Run configuration</DialogTitle>
                    <DialogDescription>
                        Configure concurrency for evaluation runs. All selected
                        cases will be executed.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="run-config-concurrency">
                            Concurrent requests
                        </Label>
                        <Input
                            id="run-config-concurrency"
                            type="number"
                            min={1}
                            value={runConfig.concurrentRequests}
                            onChange={(event) =>
                                handleNumberChange(
                                    "concurrentRequests",
                                    event.target.value,
                                )
                            }
                        />
                        <p className="text-xs text-slate-500">
                            Maximum number of parallel requests issued to the
                            downstream agent. Click the Run button again during
                            execution to stop.
                        </p>
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function VersionSummary({
    version,
    onEdit,
    onRun,
    onDelete,
    isBusy,
    isRunning,
}: {
    version: EvaluationVersion;
    onEdit: () => void;
    onRun: () => Promise<void>;
    onDelete: () => Promise<void>;
    isBusy: boolean;
    isRunning: boolean;
}) {
    const totalCases = version.rootContexts.reduce(
        (acc, context) => acc + (context.cases?.length || 0),
        0,
    );

    // 计算得分统计
    const scoreStats = calculateVersionScore(version);

    return (
        <Card>
            <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-2">
                    <CardTitle className="text-lg">{version.label}</CardTitle>
                    {version.notes ? (
                        <CardDescription className="max-w-2xl">
                            {version.notes}
                        </CardDescription>
                    ) : (
                        <CardDescription>
                            No notes recorded for this version.
                        </CardDescription>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        variant={isRunning ? "destructive" : "default"}
                        disabled={isBusy && !isRunning}
                        onClick={() => {
                            void onRun();
                        }}
                    >
                        {isRunning ? (
                            <>
                                <Square className="mr-2 size-4" />
                                Stop
                            </>
                        ) : (
                            <>
                                <Play className="mr-2 size-4" />
                                Run version
                            </>
                        )}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={onEdit}
                    >
                        <Settings2 className="mr-2 size-4" />
                        Edit
                    </Button>
                    <Button
                        size="sm"
                        variant="destructive"
                        disabled={isBusy}
                        onClick={() => {
                            void onDelete();
                        }}
                    >
                        <Trash2 className="mr-2 size-4" />
                        Delete
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                    <StatTile
                        label="Contexts"
                        value={`${version.rootContexts.length}`}
                    />
                    <StatTile label="Cases" value={`${totalCases}`} />
                    <StatTile
                        label="Average Score"
                        value={formatScore(scoreStats.averageScore)}
                    />
                    <StatTile
                        label="Scored"
                        value={`${scoreStats.scoredItems}/${scoreStats.totalItems}`}
                    />
                    <StatTile
                        label="Pass Rate"
                        value={formatPassRate(
                            scoreStats.passCount,
                            scoreStats.scoredItems,
                        )}
                    />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <StatTile
                        label="Agent endpoint"
                        value={version.agentBaseUrl ?? "—"}
                    />
                    <StatTile
                        label="Mode"
                        value={
                            version.mode === "voice-agent"
                                ? "Voice Agent (JSON)"
                                : "Agent (SSE)"
                        }
                    />
                </div>
                <div className="space-y-3">
                    <h4 className="text-sm font-semibold text-slate-700">
                        Contexts
                    </h4>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {version.rootContexts.map((context) => (
                            <div
                                key={context.id}
                                className="rounded-lg border bg-slate-50 px-4 py-3"
                            >
                                <p className="text-sm font-medium text-slate-900">
                                    {context.name}
                                </p>
                                <p className="text-xs text-slate-500">
                                    {context.cases?.length || 0} case
                                    {(context.cases?.length || 0) === 1
                                        ? ""
                                        : "s"}
                                </p>
                            </div>
                        ))}
                        {version.rootContexts.length === 0 ? (
                            <div className="rounded-lg border border-dashed bg-white px-4 py-6 text-center text-sm text-slate-500">
                                No contexts yet. Add one from the sidebar.
                            </div>
                        ) : null}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function StatTile({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border bg-white px-4 py-3 shadow-xs">
            <p className="text-xs uppercase tracking-wide text-slate-500">
                {label}
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
        </div>
    );
}

function VersionEditDialog({
    open,
    onOpenChange,
    version,
    onSave,
    onDelete,
    isBusy,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    version: EvaluationVersion;
    onSave: (updates: Partial<EvaluationVersion>) => Promise<void>;
    onDelete: () => Promise<void>;
    isBusy: boolean;
}) {
    const [label, setLabel] = useState(version.label);
    const [notes, setNotes] = useState(version.notes ?? "");
    const [agentBaseUrl, setAgentBaseUrl] = useState(
        version.agentBaseUrl ?? "",
    );
    const [mode, setMode] = useState<VersionMode>(version.mode ?? "agent");
    const [environmentText, setEnvironmentText] = useState(
        JSON.stringify(
            readLocalJson<Environment>(
                getAgentEnvironmentStorageKey(version.id),
                {},
            ),
            null,
            2,
        ),
    );
    const initialAgentHeaders = readLocalJson<Record<string, string>>(
        getAgentHeadersStorageKey(version.id),
        {},
    );
    const [agentAuth, setAgentAuth] = useState(
        getHeaderValue(initialAgentHeaders, "Authorization"),
    );
    const [agentFamilyId, setAgentFamilyId] = useState(
        getHeaderValue(initialAgentHeaders, "X-Family-ID"),
    );
    const [agentTimezone, setAgentTimezone] = useState(
        getHeaderValue(initialAgentHeaders, "X-Timezone"),
    );
    const [voiceAgentToken, setVoiceAgentToken] = useState("");
    const [isHydratingEnvironment, setIsHydratingEnvironment] =
        useState(false);

    useEffect(() => {
        if (!open) return;
        setLabel(version.label);
        setNotes(version.notes ?? "");
        setAgentBaseUrl(version.agentBaseUrl ?? "");
        setMode(version.mode ?? "agent");
        setEnvironmentText(
            JSON.stringify(
                readLocalJson<Environment>(
                    getAgentEnvironmentStorageKey(version.id),
                    {},
                ),
                null,
                2,
            ),
        );
        const storedAgentHeaders = readLocalJson<Record<string, string>>(
            getAgentHeadersStorageKey(version.id),
            {},
        );
        setAgentAuth(getHeaderValue(storedAgentHeaders, "Authorization"));
        setAgentFamilyId(getHeaderValue(storedAgentHeaders, "X-Family-ID"));
        setAgentTimezone(getHeaderValue(storedAgentHeaders, "X-Timezone"));
        setVoiceAgentToken(
            localStorage.getItem(`voice-agent-token:${version.id}`) ?? "",
        );
    }, [open, version]);

    const totalContexts = version.rootContexts.length;
    const totalCases = version.rootContexts.reduce(
        (acc, context) => acc + (context.cases?.length || 0),
        0,
    );

    const handleSave = async () => {
        if (!label.trim()) {
            toast.error("Version label cannot be empty.");
            return;
        }

        let parsedEnvironment: Record<string, unknown> = {};
        let parsedHeaders: Record<string, string> = {};

        if (mode === "agent") {
            try {
                parsedEnvironment =
                    environmentText.trim().length > 0
                        ? JSON.parse(environmentText)
                        : {};
            } catch {
                toast.error("Environment JSON is invalid.");
                return;
            }

            parsedHeaders = buildAgentHeadersFromFields(
                agentAuth,
                agentFamilyId,
                agentTimezone,
            );
        }

        if (mode === "voice-agent" && voiceAgentToken) {
            localStorage.setItem(
                `voice-agent-token:${version.id}`,
                voiceAgentToken,
            );
        } else {
            localStorage.removeItem(`voice-agent-token:${version.id}`);
        }

        if (mode === "agent") {
            writeLocalJson(
                getAgentEnvironmentStorageKey(version.id),
                parsedEnvironment,
            );
            writeLocalJson(getAgentHeadersStorageKey(version.id), parsedHeaders);
        }

        await onSave({
            label,
            notes,
            agentBaseUrl,
            mode,
        });
        onOpenChange(false);
    };

    const handleHydrateEnvironment = async () => {
        const parsedHeaders = buildAgentHeadersFromFields(
            agentAuth,
            agentFamilyId,
            agentTimezone,
        );

        if (!parsedHeaders.Authorization) {
            toast.error("Auth is required.");
            return;
        }
        if (!parsedHeaders["X-Family-ID"]) {
            toast.error("Family ID is required.");
            return;
        }
        if (!parsedHeaders["X-Timezone"]) {
            toast.error("Timezone is required.");
            return;
        }

        setIsHydratingEnvironment(true);
        try {
            const response = await fetch("/api/evaluations/agent-context", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    headers: parsedHeaders,
                }),
            });
            const data = (await response
                .json()
                .catch(() => ({}))) as {
                error?: string;
                environment?: Environment;
            };

            if (!response.ok) {
                throw new Error(
                    data?.error ?? `Request failed with ${response.status}`,
                );
            }

            const environment = (data?.environment ?? {}) as Environment;
            const nextEnvironmentText = JSON.stringify(environment, null, 2);
            setEnvironmentText(nextEnvironmentText);
            writeLocalJson(
                getAgentEnvironmentStorageKey(version.id),
                environment,
            );
            writeLocalJson(getAgentHeadersStorageKey(version.id), parsedHeaders);
            toast.success("Environment hydrated from auth.");
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to hydrate environment.",
            );
        } finally {
            setIsHydratingEnvironment(false);
        }
    };

    const handleDelete = async () => {
        await onDelete();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Edit version</DialogTitle>
                    <DialogDescription>
                        Update metadata and downstream agent configuration.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="edit-version-label">Label</Label>
                            <Input
                                id="edit-version-label"
                                value={label}
                                onChange={(event) =>
                                    setLabel(event.target.value)
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-version-agent">
                                Agent endpoint
                            </Label>
                            <Input
                                id="edit-version-agent"
                                placeholder={
                                    mode === "voice-agent"
                                        ? "https://example.com/voice-agent-proxy/chat"
                                        : "https://example.com/agent"
                                }
                                value={agentBaseUrl}
                                onChange={(event) =>
                                    setAgentBaseUrl(event.target.value)
                                }
                            />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="edit-version-mode">Mode</Label>
                        <Select
                            value={mode}
                            onValueChange={(v) => setMode(v as VersionMode)}
                        >
                            <SelectTrigger id="edit-version-mode">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="agent">
                                    Agent (SSE Stream)
                                </SelectItem>
                                <SelectItem value="voice-agent">
                                    Voice Agent (JSON)
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-slate-500">
                            {mode === "voice-agent"
                                ? "Voice Agent uses the full URL as endpoint and expects JSON response."
                                : "Agent appends /agent/v1/chat/completion/stream and expects SSE response."}
                        </p>
                    </div>
                    {mode === "voice-agent" && (
                        <div className="space-y-2">
                            <Label htmlFor="edit-version-token">
                                Auth Token
                            </Label>
                            <Input
                                id="edit-version-token"
                                type="text"
                                placeholder="Bearer token for voice agent endpoint"
                                value={voiceAgentToken}
                                onChange={(event) =>
                                    setVoiceAgentToken(event.target.value)
                                }
                            />
                            <p className="text-xs text-slate-500">
                                Stored locally in browser. Sent as
                                Authorization: Bearer header.
                            </p>
                        </div>
                    )}
                    {mode === "agent" && (
                        <>
                            <div className="space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <Label htmlFor="edit-version-environment">
                                        Environment JSON
                                    </Label>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={handleHydrateEnvironment}
                                        disabled={
                                            isBusy || isHydratingEnvironment
                                        }
                                    >
                                        <RefreshCw
                                            className={cn(
                                                "mr-2 size-4",
                                                isHydratingEnvironment &&
                                                    "animate-spin",
                                            )}
                                        />
                                        Auto fill
                                    </Button>
                                </div>
                                <Textarea
                                    id="edit-version-environment"
                                    rows={8}
                                    value={environmentText}
                                    onChange={(event) =>
                                        setEnvironmentText(event.target.value)
                                    }
                                />
                                <p className="text-xs text-slate-500">
                                    Uses Auth, Family ID, and Timezone below to
                                    fetch the role and environment, then stores
                                    the result locally.
                                </p>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2 md:col-span-2">
                                    <Label htmlFor="edit-version-agent-auth">
                                        Auth
                                    </Label>
                                    <Input
                                        id="edit-version-agent-auth"
                                        type="text"
                                        placeholder="Bearer token"
                                        value={agentAuth}
                                        onChange={(event) =>
                                            setAgentAuth(event.target.value)
                                        }
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="edit-version-family-id">
                                        Family ID
                                    </Label>
                                    <Input
                                        id="edit-version-family-id"
                                        type="text"
                                        placeholder="5edf28bf-..."
                                        value={agentFamilyId}
                                        onChange={(event) =>
                                            setAgentFamilyId(event.target.value)
                                        }
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="edit-version-timezone">
                                        Timezone
                                    </Label>
                                    <Input
                                        id="edit-version-timezone"
                                        type="text"
                                        placeholder="Asia/Shanghai"
                                        value={agentTimezone}
                                        onChange={(event) =>
                                            setAgentTimezone(event.target.value)
                                        }
                                    />
                                </div>
                            </div>
                        </>
                    )}
                    <div className="space-y-2">
                        <Label htmlFor="edit-version-notes">Notes</Label>
                        <Textarea
                            id="edit-version-notes"
                            rows={4}
                            value={notes}
                            onChange={(event) => setNotes(event.target.value)}
                        />
                        <p className="text-xs text-slate-500">
                            {totalContexts} context
                            {totalContexts === 1 ? "" : "s"} · {totalCases} case
                            {totalCases === 1 ? "" : "s"} attached.
                        </p>
                    </div>
                </div>
                <DialogFooter className="flex-row justify-between gap-2">
                    <Button
                        variant="destructive"
                        disabled={isBusy}
                        onClick={() => {
                            void handleDelete();
                        }}
                    >
                        <Trash2 className="mr-2 size-4" />
                        Delete version
                    </Button>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={isBusy}
                            onClick={() => {
                                void handleSave();
                            }}
                        >
                            Save changes
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ContextSummary({
    context,
    isBusy,
    isRunning,
    runningSource,
    onEdit,
    onRun,
    onDelete,
    onAddCase,
    onRunCase,
    onEditCase,
    onSelectCase,
    selectedCaseId,
    onRefresh,
}: {
    context: EvaluationContext;
    isBusy: boolean;
    isRunning: boolean;
    runningSource: RunSource;
    onEdit: () => void;
    onRun: () => Promise<void>;
    onDelete: () => Promise<void>;
    onAddCase: () => Promise<void>;
    onRunCase: (caseId: string, label: string) => Promise<void>;
    onEditCase: (caseId: string) => void;
    onSelectCase: (caseId: string) => void;
    selectedCaseId: string | null;
    onRefresh: () => Promise<void>;
}) {
    const isRootContext = !context.parentContextId;
    const isChildContext = !!context.parentContextId;
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
    const [isBatchAddDialogOpen, setBatchAddDialogOpen] = useState(false);

    // 计算当前 Context 的得分统计
    const scoreStats = calculateContextScore(context);

    const handleGenerateSummary = async () => {
        setIsGeneratingSummary(true);
        try {
            const response = await fetch(
                `/api/evaluations/contexts/${context.id}/generate-summary`,
                {
                    method: "POST",
                },
            );

            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new Error(
                    errorData.error || "Failed to generate summary",
                );
            }

            const data = await response.json();
            toast.success("Summary generated successfully!");

            // 刷新数据以显示新生成的总结
            await onRefresh();
        } catch (error) {
            console.error("Failed to generate summary:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to generate summary",
            );
        } finally {
            setIsGeneratingSummary(false);
        }
    };

    return (
        <>
            <Card>
                <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                        <div className="flex items-center gap-2">
                            <CardTitle>{context.name}</CardTitle>
                            {isChildContext && (
                                <Badge variant="secondary">
                                    Child Context (Depth {context.depth})
                                </Badge>
                            )}
                        </div>
                        <CardDescription>
                            {context.description ?? "No description provided."}
                        </CardDescription>
                        {isChildContext && (
                            <div className="text-xs text-slate-500 mt-2">
                                This is a child context created from a case
                                result. It inherits configuration from its
                                parent and stores incremental messages.
                            </div>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            variant={
                                isRunning && runningSource === "context"
                                    ? "destructive"
                                    : "default"
                            }
                            disabled={isBusy && runningSource !== "context"}
                            onClick={() => {
                                void onRun();
                            }}
                        >
                            {isRunning && runningSource === "context" ? (
                                <>
                                    <Square className="mr-2 size-4" />
                                    Stop
                                </>
                            ) : (
                                <>
                                    <Play className="mr-2 size-4" />
                                    Run context
                                </>
                            )}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => {
                                void onAddCase();
                            }}
                        >
                            <Plus className="mr-2 size-4" />
                            Add case
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => setBatchAddDialogOpen(true)}
                        >
                            <Upload className="mr-2 size-4" />
                            Batch add cases
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={onEdit}
                        >
                            <Settings2 className="mr-2 size-4" />
                            Edit
                        </Button>
                        <Button
                            size="sm"
                            variant="destructive"
                            disabled={isBusy}
                            onClick={() => {
                                void onDelete();
                            }}
                        >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Recent Messages
                            </h4>
                            <JsonViewer
                                value={context.resolvedMessages ?? []}
                            />
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                    Context Summary
                                </h4>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isGeneratingSummary || isBusy}
                                    onClick={() => {
                                        void handleGenerateSummary();
                                    }}
                                    className="h-6 px-2 text-xs"
                                >
                                    <Sparkles className="mr-1 size-3" />
                                    {isGeneratingSummary
                                        ? "Generating..."
                                        : "Generate"}
                                </Button>
                            </div>
                            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm min-h-[100px]">
                                {context.contextSummary ? (
                                    <MarkdownRenderer
                                        content={context.contextSummary}
                                    />
                                ) : (
                                    <span className="text-slate-400 italic">
                                        No summary available
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold text-slate-700">
                                Cases
                            </h4>
                            <span className="text-xs text-slate-500">
                                {context.cases?.length || 0} total
                            </span>
                        </div>
                        {/* Score Statistics */}
                        {scoreStats.totalItems > 0 && (
                            <div className="rounded-lg border bg-slate-50 px-4 py-3">
                                <div className="flex items-center gap-6 text-sm">
                                    <div className="flex items-center gap-2">
                                        <span className="text-slate-600">
                                            Average Score:
                                        </span>
                                        <span className="font-semibold text-slate-900">
                                            {formatScore(
                                                scoreStats.averageScore,
                                            )}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-slate-600">
                                            Scored:
                                        </span>
                                        <span className="font-semibold text-slate-900">
                                            {scoreStats.scoredItems}/
                                            {scoreStats.totalItems}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-slate-600">
                                            Pass Rate:
                                        </span>
                                        <span className="font-semibold text-slate-900">
                                            {formatPassRate(
                                                scoreStats.passCount,
                                                scoreStats.scoredItems,
                                            )}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div className="space-y-2">
                            {context.cases?.map((testCase) => {
                                const status = testCase.lastRunSummary?.status;
                                const completedAt = testCase.lastRunSummary
                                    ?.completedAt
                                    ? formatDate(
                                          testCase.lastRunSummary.completedAt,
                                      )
                                    : "Never run";

                                return (
                                    <div
                                        key={testCase.id}
                                        className={cn(
                                            "rounded-lg border bg-white px-3 py-2 shadow-xs transition",
                                            selectedCaseId === testCase.id
                                                ? "border-primary bg-primary/5"
                                                : "hover:border-slate-300",
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <button
                                                type="button"
                                                className="flex-1 text-left"
                                                onClick={() =>
                                                    onSelectCase(testCase.id)
                                                }
                                            >
                                                <p className="text-sm font-medium text-slate-900">
                                                    {testCase.title}
                                                </p>
                                                <p className="text-xs text-slate-500">
                                                    {testCase.description
                                                        ? testCase.description
                                                        : "No description"}
                                                </p>
                                            </button>
                                            <div className="flex items-center gap-1">
                                                {status ? (
                                                    <Badge
                                                        variant={
                                                            statusVariantMap[
                                                                status
                                                            ]
                                                        }
                                                    >
                                                        {statusLabelMap[status]}
                                                    </Badge>
                                                ) : null}
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    disabled={isBusy}
                                                    onClick={() => {
                                                        void onRunCase(
                                                            testCase.id,
                                                            testCase.title,
                                                        );
                                                    }}
                                                    aria-label={`Run ${testCase.title}`}
                                                >
                                                    <Play className="size-4" />
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    onClick={() =>
                                                        onEditCase(testCase.id)
                                                    }
                                                    aria-label={`Edit ${testCase.title}`}
                                                >
                                                    <Settings2 className="size-4" />
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    disabled={isBusy}
                                                    onClick={async () => {
                                                        const confirmed =
                                                            window.confirm(
                                                                `Are you sure you want to delete the case "${testCase.title}"?\n\nThis action cannot be undone.`,
                                                            );
                                                        if (confirmed) {
                                                            try {
                                                                await fetch(
                                                                    `/api/evaluations/cases/${testCase.id}`,
                                                                    {
                                                                        method: "DELETE",
                                                                    },
                                                                );
                                                                await onRefresh();
                                                                // Show success toast
                                                                const {
                                                                    toast,
                                                                } =
                                                                    await import(
                                                                        "react-hot-toast"
                                                                    );
                                                                toast.success(
                                                                    "Case deleted successfully",
                                                                );
                                                            } catch (error) {
                                                                const {
                                                                    toast,
                                                                } =
                                                                    await import(
                                                                        "react-hot-toast"
                                                                    );
                                                                toast.error(
                                                                    error instanceof
                                                                        Error
                                                                        ? error.message
                                                                        : "Failed to delete case",
                                                                );
                                                            }
                                                        }
                                                    }}
                                                    aria-label={`Delete ${testCase.title}`}
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                                            <span>{completedAt}</span>
                                            {testCase.lastRunSummary
                                                ?.durationMs ? (
                                                <span>
                                                    {
                                                        testCase.lastRunSummary
                                                            .durationMs
                                                    }{" "}
                                                    ms
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            })}
                            {(context.cases?.length || 0) === 0 ? (
                                <div className="rounded-lg border border-dashed bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                                    No cases yet. Use "Add case" to create one.
                                </div>
                            ) : null}
                        </div>
                    </div>
                </CardContent>
            </Card>
            {/* Batch Add Cases Dialog */}
            <BatchAddCasesDialog
                open={isBatchAddDialogOpen}
                onOpenChange={setBatchAddDialogOpen}
                contextId={context.id}
                onSuccess={onRefresh}
                isBusy={isBusy}
            />
        </>
    );
}

function ContextEditDialog({
    open,
    onOpenChange,
    context,
    onSave,
    isBusy,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    context: EvaluationContext;
    onSave: (updates: Partial<EvaluationContext>) => Promise<void>;
    isBusy: boolean;
}) {
    const [name, setName] = useState(context.name);
    const [description, setDescription] = useState(context.description ?? "");
    const [contextSummary, setContextSummary] = useState(
        context.contextSummary ?? "",
    );

    useEffect(() => {
        if (!open) return;
        setName(context.name);
        setDescription(context.description ?? "");
        setContextSummary(context.contextSummary ?? "");
    }, [open, context]);

    const handleSave = async () => {
        await onSave({
            name,
            description,
            contextSummary,
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>Edit context</DialogTitle>
                    <DialogDescription>
                        Adjust metadata and summary for this context.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="edit-context-name">Name</Label>
                            <Input
                                id="edit-context-name"
                                value={name}
                                onChange={(event) =>
                                    setName(event.target.value)
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-context-description">
                                Description
                            </Label>
                            <Input
                                id="edit-context-description"
                                value={description}
                                onChange={(event) =>
                                    setDescription(event.target.value)
                                }
                            />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="edit-context-summary">
                            Context Summary
                        </Label>
                        <Textarea
                            id="edit-context-summary"
                            rows={4}
                            value={contextSummary}
                            placeholder="Enter a summary for this context..."
                            onChange={(event) =>
                                setContextSummary(event.target.value)
                            }
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={isBusy}
                        onClick={() => {
                            void handleSave();
                        }}
                    >
                        Save changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CaseSummary({
    context,
    testCase,
    onRun,
    onDelete,
    onEdit,
    isBusy,
    isRunning,
    runningSource,
    onRefresh,
    versionId,
    onUpdateCase,
    versionMode,
}: {
    context: EvaluationContext;
    testCase: EvaluationCase;
    onRun: () => Promise<void>;
    onDelete: () => Promise<void>;
    onEdit: () => void;
    isBusy: boolean;
    isRunning: boolean;
    runningSource: RunSource;
    onRefresh: () => Promise<void>;
    versionId: string;
    onUpdateCase: (
        contextId: string,
        caseId: string,
        updates: Partial<EvaluationCase>,
    ) => Promise<void>;
    versionMode: VersionMode;
}) {
    const status = testCase.lastRunSummary?.status;
    const [isSaving, setIsSaving] = useState(false);
    const [isEvaluating, setIsEvaluating] = useState(false);
    const [evalRule, setEvalRule] = useState(
        testCase.evalRule || DEFAULT_EVAL_RULE,
    );
    const [isSavingEvalRule, setIsSavingEvalRule] = useState(false);

    // 按需加载 responseContent
    const [loadedResponseContent, setLoadedResponseContent] = useState<
        string | null
    >(null);
    const [isLoadingResponse, setIsLoadingResponse] = useState(false);
    const [responseLoadError, setResponseLoadError] = useState<string | null>(
        null,
    );

    // Sync evalRule with testCase.evalRule when it changes
    useEffect(() => {
        setEvalRule(testCase.evalRule || DEFAULT_EVAL_RULE);
    }, [testCase.evalRule]);

    // 加载 responseContent 的函数
    const loadResponseContent = async () => {
        setIsLoadingResponse(true);
        setResponseLoadError(null);
        try {
            const response = await fetch(
                `/api/evaluations/results?versionId=${versionId}&caseId=${testCase.id}`,
            );

            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new Error(errorData.error || "Failed to load response");
            }

            const data = (await response.json()) as { responseContent: string };
            setLoadedResponseContent(data.responseContent);
        } catch (error) {
            console.error("Failed to load response content:", error);
            setResponseLoadError(
                error instanceof Error
                    ? error.message
                    : "Failed to load response",
            );
        } finally {
            setIsLoadingResponse(false);
        }
    };

    // 当切换到新的 case 时，自动加载 responseContent
    useEffect(() => {
        setLoadedResponseContent(null);
        setResponseLoadError(null);

        // 如果当前 case 有执行结果但没有 responseContent，自动加载
        if (
            testCase.lastRunSummary &&
            !testCase.lastRunSummary.responseContent
        ) {
            void loadResponseContent();
        }
    }, [testCase.id, versionId]);

    const handleSaveEvalRule = async () => {
        setIsSavingEvalRule(true);
        try {
            await onUpdateCase(context.id, testCase.id, {
                evalRule: evalRule.trim() || DEFAULT_EVAL_RULE,
            });
            toast.success("Evaluation rule saved successfully!");
        } catch (error) {
            console.error("Failed to save evaluation rule:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save evaluation rule",
            );
        } finally {
            setIsSavingEvalRule(false);
        }
    };

    const handleEvaluate = async () => {
        setIsEvaluating(true);
        try {
            const response = await fetch(
                `/api/evaluations/cases/${testCase.id}/evaluate`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        versionId,
                    }),
                },
            );

            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new Error(errorData.error || "Failed to evaluate");
            }

            const data = await response.json();
            toast.success("Evaluation completed successfully!");

            // 刷新数据以显示新的评估结果
            await onRefresh();
        } catch (error) {
            console.error("Failed to evaluate:", error);
            toast.error(
                error instanceof Error ? error.message : "Failed to evaluate",
            );
        } finally {
            setIsEvaluating(false);
        }
    };

    const handleSaveToContext = async () => {
        const responseContent =
            testCase.lastRunSummary?.responseContent || loadedResponseContent;

        if (!responseContent) {
            toast.error("No response content to save");
            return;
        }

        // 前端诊断：仅对 SSE agent 模式分析 responseContent
        if (versionMode !== "voice-agent") {
            console.log(
                "[Frontend Debug] Analyzing responseContent before saving...",
            );

            const lines = responseContent.split("\n");
            const eventTypes = new Map<string, number>();
            let toolCallCount = 0;
            let toolResultCount = 0;

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    try {
                        const event = JSON.parse(line.substring(6)) as any;
                        const type = event.type || "unknown";
                        eventTypes.set(type, (eventTypes.get(type) || 0) + 1);

                        if (type.toLowerCase().includes("tool")) {
                            if (type.includes("call") || type.includes("use")) {
                                toolCallCount++;
                            } else if (type.includes("result")) {
                                toolResultCount++;
                            }
                        }
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }

            console.log("[Frontend Debug] SSE Analysis:", {
                totalLines: lines.length,
                eventTypes: Object.fromEntries(eventTypes),
                toolCallEvents: toolCallCount,
                toolResultEvents: toolResultCount,
            });
        }

        setIsSaving(true);
        try {
            const response = await fetch(
                `/api/evaluations/contexts/${context.id}/save-result`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        userMessage: testCase.userMessage,
                        responseContent: responseContent,
                        caseTitle: testCase.title,
                        mode: versionMode,
                    }),
                },
            );

            if (!response.ok) {
                const error = (await response.json()) as { error?: string };
                throw new Error(error.error || "Failed to save to context");
            }

            const result = (await response.json()) as {
                success: boolean;
                newContextId: string;
                messagesAdded: number;
            };
            toast.success(
                `Created new context with ${result.messagesAdded} messages`,
            );

            // 刷新数据以显示新创建的 context
            await onRefresh();
        } catch (error) {
            console.error("Failed to save to context:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save to context",
            );
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                        <CardTitle>{testCase.title}</CardTitle>
                        <CardDescription>
                            {testCase.description ?? "No description provided."}
                        </CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            variant={
                                isRunning && runningSource === "case"
                                    ? "destructive"
                                    : "default"
                            }
                            disabled={isBusy && runningSource !== "case"}
                            onClick={() => {
                                void onRun();
                            }}
                        >
                            {isRunning && runningSource === "case" ? (
                                <>
                                    <Square className="mr-2 size-4" />
                                    Stop
                                </>
                            ) : (
                                <>
                                    <Play className="mr-2 size-4" />
                                    Run case
                                </>
                            )}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={onEdit}
                        >
                            <Settings2 className="mr-2 size-4" />
                            Edit
                        </Button>
                        <Button
                            size="sm"
                            variant="destructive"
                            disabled={isBusy}
                            onClick={() => {
                                void onDelete();
                            }}
                        >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-slate-50 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Database className="size-4 text-slate-500" />
                            <span className="text-xs uppercase tracking-wider text-slate-500">
                                Context:
                            </span>
                            <span className="text-sm font-medium text-slate-900">
                                {context.name}
                            </span>
                        </div>
                        {status && (
                            <div className="flex items-center gap-2">
                                <span className="text-xs uppercase tracking-wider text-slate-500">
                                    Status:
                                </span>
                                <Badge variant={statusVariantMap[status]}>
                                    {statusLabelMap[status]}
                                </Badge>
                            </div>
                        )}
                        {testCase.lastRunSummary?.durationMs && (
                            <div className="flex items-center gap-2">
                                <Clock className="size-4 text-slate-500" />
                                <span className="text-xs uppercase tracking-wider text-slate-500">
                                    Duration:
                                </span>
                                <span className="text-sm font-medium text-slate-900">
                                    {testCase.lastRunSummary.durationMs} ms
                                </span>
                            </div>
                        )}
                        {testCase.lastRunSummary?.completedAt && (
                            <div className="flex items-center gap-2">
                                <span className="text-xs uppercase tracking-wider text-slate-500">
                                    Completed:
                                </span>
                                <span className="text-sm font-medium text-slate-900">
                                    {formatDate(
                                        testCase.lastRunSummary.completedAt,
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Context Summary</CardTitle>
                    <CardDescription>
                        Summary of the conversation context
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm min-h-[60px]">
                        {context.contextSummary ? (
                            <MarkdownRenderer
                                content={context.contextSummary}
                            />
                        ) : (
                            <span className="text-slate-400 italic">
                                No summary available
                            </span>
                        )}
                    </div>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>User message</CardTitle>
                </CardHeader>
                <CardContent>
                    <UserMessageDisplay message={testCase.userMessage} />
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                        <CardTitle>Evaluation</CardTitle>
                        <CardDescription>
                            Evaluation criteria and results
                        </CardDescription>
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={
                            !testCase.lastRunSummary ||
                            testCase.lastRunSummary.status !== "succeeded" ||
                            isEvaluating ||
                            isBusy
                        }
                        onClick={() => {
                            void handleEvaluate();
                        }}
                        className="h-8 px-3 text-xs"
                    >
                        <Sparkles className="mr-1 size-3" />
                        {isEvaluating ? "Evaluating..." : "Evaluate"}
                    </Button>
                </CardHeader>
                <CardContent>
                    <div className="space-y-6">
                        {/* Score and Evaluation Rule in one row */}
                        <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
                            {/* Score */}
                            <div className="space-y-2">
                                <span className="text-sm font-semibold text-slate-700">
                                    Score
                                </span>
                                <div className="flex items-center">
                                    {testCase.lastRunSummary?.score !==
                                    undefined ? (
                                        <Badge
                                            variant="default"
                                            className="text-lg px-4 py-2"
                                        >
                                            {testCase.lastRunSummary.score}
                                        </Badge>
                                    ) : (
                                        <span className="text-sm text-slate-400">
                                            -
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Evaluation Rule */}
                            <div className="space-y-2 md:col-span-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-semibold text-slate-700">
                                        Evaluation Rule
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={isSavingEvalRule || isBusy}
                                        onClick={() => {
                                            void handleSaveEvalRule();
                                        }}
                                        className="h-7 px-2 text-xs"
                                    >
                                        <Save className="mr-1 size-3" />
                                        {isSavingEvalRule
                                            ? "Saving..."
                                            : "Save"}
                                    </Button>
                                </div>
                                <Textarea
                                    value={evalRule}
                                    onChange={(e) =>
                                        setEvalRule(e.target.value)
                                    }
                                    rows={4}
                                    className="text-sm"
                                    placeholder="Enter evaluation criteria..."
                                />
                                <p className="text-xs text-slate-500">
                                    Default rule is provided if empty. You can
                                    customize it for specific requirements.
                                </p>
                            </div>
                        </div>

                        {/* Overview in full width row */}
                        <div className="space-y-2">
                            <span className="text-sm font-semibold text-slate-700">
                                Overview
                            </span>
                            <div className="rounded-md border border-slate-200 bg-white p-3 text-sm min-h-[60px]">
                                {testCase.lastRunSummary?.resultOverview ? (
                                    <MarkdownRenderer
                                        content={
                                            testCase.lastRunSummary
                                                .resultOverview
                                        }
                                    />
                                ) : (
                                    <span className="text-slate-400 italic">
                                        No overview available
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
            {testCase.lastRunSummary ? (
                <Card>
                    <CardHeader>
                        <div className="flex items-start justify-between">
                            <div className="space-y-1">
                                <CardTitle>Response content</CardTitle>
                                <CardDescription>
                                    {versionMode === "voice-agent"
                                        ? "JSON response from the voice agent."
                                        : "Stream response from the agent."}
                                </CardDescription>
                            </div>
                            {(testCase.lastRunSummary.responseContent ||
                                loadedResponseContent) && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isSaving || isBusy}
                                    onClick={() => {
                                        void handleSaveToContext();
                                    }}
                                >
                                    <Save className="mr-2 size-4" />
                                    {isSaving ? "Saving..." : "Save to Context"}
                                </Button>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        {testCase.lastRunSummary.responseContent ||
                        loadedResponseContent ? (
                            versionMode === "voice-agent" ? (
                                <VoiceAgentResponseViewer
                                    responseContent={
                                        testCase.lastRunSummary
                                            .responseContent ||
                                        loadedResponseContent!
                                    }
                                />
                            ) : (
                                <SSEResponseViewer
                                    responseContent={
                                        testCase.lastRunSummary
                                            .responseContent ||
                                        loadedResponseContent!
                                    }
                                />
                            )
                        ) : isLoadingResponse ? (
                            <div className="flex items-center justify-center py-8 text-slate-500">
                                <div className="flex items-center gap-2">
                                    <div className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                                    <span>Loading response content...</span>
                                </div>
                            </div>
                        ) : responseLoadError ? (
                            <div className="flex flex-col items-center justify-center py-8 text-slate-500">
                                <p className="mb-3 text-sm text-red-600">
                                    {responseLoadError}
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        void loadResponseContent();
                                    }}
                                >
                                    Retry
                                </Button>
                            </div>
                        ) : (
                            <div className="flex items-center justify-center py-8">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        void loadResponseContent();
                                    }}
                                >
                                    Load Response Content
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
}

function CaseEditDialog({
    open,
    onOpenChange,
    context,
    testCase,
    onSave,
    isBusy,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    context: EvaluationContext;
    testCase: EvaluationCase;
    onSave: (updates: Partial<EvaluationCase>) => Promise<void>;
    isBusy: boolean;
}) {
    const [title, setTitle] = useState(testCase.title);
    const [description, setDescription] = useState(testCase.description ?? "");
    const [userMessageText, setUserMessageText] = useState(() => {
        const content = testCase.userMessage.content;
        return typeof content === "string" ? content : "";
    });
    const [evalRule, setEvalRule] = useState(
        testCase.evalRule || DEFAULT_EVAL_RULE,
    );

    useEffect(() => {
        if (!open) return;
        setTitle(testCase.title);
        setDescription(testCase.description ?? "");
        const content = testCase.userMessage.content;
        setUserMessageText(typeof content === "string" ? content : "");
        setEvalRule(testCase.evalRule || DEFAULT_EVAL_RULE);
    }, [open, testCase]);

    const handleSave = async () => {
        // 自动设置标题：如果是默认标题或为空，且 userMessage 有内容，则使用 userMessage 的第一行作为标题
        let finalTitle = title.trim();
        const trimmedMessage = userMessageText.trim();

        if ((!finalTitle || finalTitle === "New Case") && trimmedMessage) {
            // 取第一行或前 50 个字符作为标题
            const firstLine = trimmedMessage.split("\n")[0];
            finalTitle =
                firstLine.length > 50
                    ? firstLine.substring(0, 50) + "..."
                    : firstLine;
        }

        const userMessage: EvaluationCase["userMessage"] = {
            role: "user",
            content: userMessageText,
        };
        await onSave({
            title: finalTitle || title, // 如果 finalTitle 为空，使用原 title
            description,
            userMessage,
            evalRule: evalRule.trim() || DEFAULT_EVAL_RULE,
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Edit case</DialogTitle>
                    <DialogDescription>
                        Configure prompts and expected outputs for{" "}
                        <span className="font-medium">{context.name}</span>.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="edit-case-title">Title</Label>
                            <Input
                                id="edit-case-title"
                                value={title}
                                onChange={(event) =>
                                    setTitle(event.target.value)
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="edit-case-description">
                                Description
                            </Label>
                            <Input
                                id="edit-case-description"
                                value={description}
                                onChange={(event) =>
                                    setDescription(event.target.value)
                                }
                            />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="edit-case-user-message">
                            User message
                        </Label>
                        <Textarea
                            id="edit-case-user-message"
                            rows={10}
                            value={userMessageText}
                            placeholder="Enter user message content..."
                            onChange={(event) =>
                                setUserMessageText(event.target.value)
                            }
                        />
                    </div>
                    <Separator />
                    <div className="space-y-2">
                        <Label htmlFor="edit-case-eval-rule">
                            Evaluation Rule
                        </Label>
                        <Textarea
                            id="edit-case-eval-rule"
                            rows={6}
                            value={evalRule}
                            placeholder="Enter evaluation criteria..."
                            onChange={(event) =>
                                setEvalRule(event.target.value)
                            }
                        />
                        <p className="text-xs text-slate-500">
                            Default rule is provided if empty. You can customize
                            it for specific requirements.
                        </p>
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={isBusy}
                        onClick={() => {
                            void handleSave();
                        }}
                    >
                        Save changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function EmptyState() {
    return (
        <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed bg-slate-50 text-center text-slate-500">
            <p>No data selected.</p>
            <p className="text-sm">
                Choose a version, context, or case to inspect.
            </p>
        </div>
    );
}

function InfoRow({
    icon,
    label,
    value,
}: {
    icon: ReactNode;
    label: string;
    value: string;
}) {
    return (
        <div className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-2 text-slate-600">{icon}</div>
            <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">
                    {label}
                </p>
                <p className="text-sm font-medium text-slate-900">{value}</p>
            </div>
        </div>
    );
}

// Simplified component for displaying user message without nested borders
function UserMessageDisplay({
    message,
}: {
    message: EvaluationCase["userMessage"];
}) {
    if (typeof message.content === "string") {
        return (
            <div className="text-base text-slate-900 whitespace-pre-wrap break-words">
                {message.content.trim().length > 0 ? (
                    message.content
                ) : (
                    <span className="text-slate-400">Empty content</span>
                )}
            </div>
        );
    }

    if (!message.content.length) {
        return (
            <div className="text-sm text-slate-500">No parts configured.</div>
        );
    }

    return (
        <div className="space-y-4">
            {message.content.map((part, index) => {
                if (part.type === "text") {
                    return (
                        <div
                            key={`${part.type}-${index}`}
                            className="text-base text-slate-900 whitespace-pre-wrap break-words"
                        >
                            {part.text}
                        </div>
                    );
                }

                if (part.type === "image") {
                    return (
                        <div
                            key={`${part.type}-${index}`}
                            className="space-y-2"
                        >
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                <span>Image:</span>
                                <span className="truncate max-w-[400px]">
                                    {part.url}
                                </span>
                            </div>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={part.url}
                                alt={part.alt ?? ""}
                                className="max-w-full h-auto rounded-md border"
                            />
                            {part.alt && (
                                <p className="text-sm text-slate-600">
                                    {part.alt}
                                </p>
                            )}
                        </div>
                    );
                }

                if (part.type === "file") {
                    return (
                        <div
                            key={`${part.type}-${index}`}
                            className="flex items-center gap-2 text-sm text-slate-700"
                        >
                            <span className="text-slate-500">File:</span>
                            <a
                                href={part.url}
                                className="text-primary underline"
                                target="_blank"
                                rel="noreferrer"
                            >
                                {part.name ?? part.url}
                            </a>
                        </div>
                    );
                }

                return null;
            })}
        </div>
    );
}

function MessagePreview({
    message,
}: {
    message: EvaluationCase["userMessage"] | undefined;
}) {
    if (!message) {
        return (
            <div className="rounded-lg border bg-white px-4 py-3 text-sm text-slate-500 shadow-xs">
                No message configured.
            </div>
        );
    }

    if (typeof message.content === "string") {
        return (
            <div className="rounded-lg border bg-white px-4 py-3 text-sm text-slate-700 shadow-xs">
                {message.content.trim().length > 0 ? (
                    message.content
                ) : (
                    <span className="text-slate-400">Empty content</span>
                )}
            </div>
        );
    }

    if (!message.content.length) {
        return (
            <div className="rounded-lg border bg-white px-4 py-3 text-sm text-slate-500 shadow-xs">
                No parts configured.
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {message.content.map((part, index) => {
                if (part.type === "text") {
                    return (
                        <div
                            key={`${part.type}-${index}`}
                            className="rounded-lg border bg-white px-4 py-3 text-sm text-slate-700 shadow-xs"
                        >
                            {part.text}
                        </div>
                    );
                }

                if (part.type === "image") {
                    return (
                        <div
                            key={`${part.type}-${index}`}
                            className="space-y-2 rounded-lg border bg-white p-3 text-sm text-slate-700 shadow-xs"
                        >
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                                <span>Image</span>
                                <span className="truncate max-w-[240px]">
                                    {part.url}
                                </span>
                            </div>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={part.url}
                                alt={part.alt ?? ""}
                                className="h-36 w-auto rounded-md border object-cover"
                            />
                            {part.alt ? (
                                <p className="text-xs text-slate-500">
                                    Alt: {part.alt}
                                </p>
                            ) : null}
                        </div>
                    );
                }

                return (
                    <div
                        key={`${part.type}-${index}`}
                        className="rounded-lg border bg-white p-3 text-sm text-slate-700 shadow-xs"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span>File</span>
                            <a
                                href={part.url}
                                className="text-xs text-primary underline underline-offset-2"
                                target="_blank"
                                rel="noreferrer"
                            >
                                {part.name ?? "Open"}
                            </a>
                        </div>
                        <p className="mt-1 text-xs text-slate-500 break-all">
                            {part.url}
                        </p>
                        {part.mimeType ? (
                            <p className="text-xs text-slate-500">
                                MIME: {part.mimeType}
                                {typeof part.size === "number"
                                    ? ` · ${formatBytes(part.size)}`
                                    : ""}
                            </p>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function JsonViewer({ value }: { value: unknown }) {
    if (value === undefined) {
        return (
            <div className="rounded-lg border bg-white px-4 py-3 text-sm text-slate-500 shadow-xs">
                No data
            </div>
        );
    }

    return (
        <pre className="max-h-64 overflow-auto rounded-lg border bg-slate-950/90 px-4 py-3 text-[13px] leading-relaxed text-slate-100 shadow-xs">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
        </pre>
    );
}

function formatBytes(bytes?: number, decimals = 1) {
    if (bytes === undefined) return "";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

// SSE Response Types
interface SSEEvent {
    type?: string;
    timestamp?: string;
    agentName?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    text?: string;
    delta?: string;
    success?: boolean;
    error?: string;
    [key: string]: unknown;
}

// Parse SSE response into structured events
function parseSSEResponse(responseText: string): SSEEvent[] {
    const lines = responseText.split("\n");
    const events: SSEEvent[] = [];

    for (const line of lines) {
        if (line.startsWith("data: ")) {
            try {
                const jsonStr = line.substring(6);
                const event = JSON.parse(jsonStr) as SSEEvent;
                events.push(event);
            } catch {
                // Skip invalid JSON lines
            }
        }
    }

    return events;
}

// Merge text-delta events between text-start and text-end
function mergeTextDeltas(events: SSEEvent[]): SSEEvent[] {
    const merged: SSEEvent[] = [];
    let i = 0;

    while (i < events.length) {
        const event = events[i];

        // Check if this is a text-start event
        if (event.type === "text-start") {
            const startEvent = event;
            const textDeltas: string[] = [];
            let j = i + 1;

            // Collect all text-delta events until text-end
            while (j < events.length) {
                const nextEvent = events[j];

                if (
                    nextEvent.type === "text-end" &&
                    nextEvent.id === startEvent.id
                ) {
                    // Found the matching text-end, create merged event
                    if (textDeltas.length > 0) {
                        merged.push({
                            type: "text",
                            id: startEvent.id,
                            text: textDeltas.join(""),
                            agentName: startEvent.agentName,
                            timestamp: startEvent.timestamp,
                        });
                    }
                    // Skip to after text-end
                    i = j + 1;
                    break;
                }

                if (
                    nextEvent.type === "text-delta" &&
                    nextEvent.id === startEvent.id &&
                    nextEvent.text
                ) {
                    // This is a text-delta for this text block, accumulate it
                    textDeltas.push(nextEvent.text);
                } else if (
                    nextEvent.type !== "text-delta" ||
                    nextEvent.id !== startEvent.id
                ) {
                    // This is NOT a text-delta for this text block (different id or different type)
                    // It's a different event (like tool-call, tool-result, etc.)
                    // We need to preserve it!
                    merged.push(nextEvent);
                }

                j++;
            }

            // If we didn't find text-end, just skip the start event
            if (j >= events.length) {
                i++;
            }
        } else {
            // Not a text-start, add as-is
            merged.push(event);
            i++;
        }
    }

    return merged;
}

// Extract agent name from SSE events
function extractAgentName(events: SSEEvent[]): string | null {
    for (const event of events) {
        if (event.agentName) {
            return event.agentName;
        }
    }
    return null;
}

// Check if response contains any failures
function hasResponseFailure(events: SSEEvent[]): boolean {
    function checkFailure(obj: unknown): boolean {
        if (obj === null || obj === undefined) return false;
        if (typeof obj !== "object") return false;

        const record = obj as Record<string, unknown>;
        if ("success" in record && record.success === false) {
            return true;
        }

        for (const value of Object.values(record)) {
            if (typeof value === "object" && value !== null) {
                if (checkFailure(value)) {
                    return true;
                }
            }
        }

        return false;
    }

    return events.some((event) => checkFailure(event));
}

// Helper functions for SSE response viewer
function isCollapsibleEvent(event: SSEEvent): boolean {
    const type = event.type || "";
    return (
        type.includes("start") ||
        type.includes("finish") ||
        type.includes("end") ||
        type === "text-delta" ||
        type === "tool-input-delta"
    );
}

function getEventBorderColor(type: string): string {
    if (type.includes("start")) return "border-blue-500";
    if (type.includes("finish") || type.includes("end"))
        return "border-purple-500";
    if (type === "text") return "border-orange-500";
    if (type === "text-delta") return "border-orange-500";
    if (type === "tool-call") return "border-cyan-500";
    if (type === "tool-result") return "border-green-500";
    if (type.includes("error")) return "border-red-500";
    return "border-gray-500";
}

function getEventLabel(event: SSEEvent): string | null {
    const type = event.type || "";
    if (type.includes("start")) return "START";
    if (type.includes("finish") || type.includes("end")) return "END";
    if (type === "tool-input-delta") return "TOOL INPUT";
    return null;
}

function CopyChunkButton({ getData }: { getData: () => string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(getData());
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }}
        >
            {copied ? "Copied" : "Copy"}
        </button>
    );
}

function highlightImportantKeys(obj: unknown): string {
    const json = JSON.stringify(obj, null, 2);
    const importantKeys = [
        "agentName",
        "toolName",
        "input",
        "text",
        "success",
        "output",
        "error",
    ];

    let highlighted = json;
    importantKeys.forEach((key) => {
        const regex = new RegExp(`"(${key})"(?=:)`, "g");
        highlighted = highlighted.replace(regex, `**"$1"**`);
    });

    return highlighted;
}

// Component to display organized SSE response
function SSEResponseViewer({ responseContent }: { responseContent: string }) {
    const [showHidden, setShowHidden] = useState(false);
    const [expandedEvents, setExpandedEvents] = useState<Set<number>>(
        new Set(),
    );

    const rawEvents = useMemo(
        () => parseSSEResponse(responseContent),
        [responseContent],
    );
    const events = useMemo(() => {
        const merged = mergeTextDeltas(rawEvents);

        // 调试：统计事件类型
        const eventTypes = new Map<string, number>();
        rawEvents.forEach((e) => {
            const type = e.type || "unknown";
            eventTypes.set(type, (eventTypes.get(type) || 0) + 1);
        });

        const mergedEventTypes = new Map<string, number>();
        merged.forEach((e) => {
            const type = e.type || "unknown";
            mergedEventTypes.set(type, (mergedEventTypes.get(type) || 0) + 1);
        });

        console.log("[SSEResponseViewer] Event processing:", {
            rawEventsCount: rawEvents.length,
            mergedEventsCount: merged.length,
            rawEventTypes: Object.fromEntries(eventTypes),
            mergedEventTypes: Object.fromEntries(mergedEventTypes),
        });

        // 检查 tool-call 是否被过滤掉
        const toolCallInRaw = rawEvents.filter(
            (e) => e.type === "tool-call",
        ).length;
        const toolCallInMerged = merged.filter(
            (e) => e.type === "tool-call",
        ).length;

        if (toolCallInRaw > 0 && toolCallInMerged === 0) {
            console.warn(
                "⚠️ [SSEResponseViewer] tool-call events were filtered out during merge!",
            );
            console.warn(
                "Raw tool-call events:",
                rawEvents.filter((e) => e.type === "tool-call"),
            );
        }

        return merged;
    }, [rawEvents]);
    const agentName = useMemo(() => extractAgentName(events), [events]);
    const hasFailure = useMemo(() => hasResponseFailure(events), [events]);

    const toggleEvent = useCallback((index: number) => {
        setExpandedEvents((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {agentName && (
                        <Badge variant="outline" className="font-mono text-xs">
                            Agent: {agentName}
                        </Badge>
                    )}
                    {hasFailure && (
                        <Badge variant="destructive" className="text-xs">
                            Has Failures
                        </Badge>
                    )}
                    <Badge variant="secondary" className="text-xs">
                        {events.length} events
                    </Badge>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-600">
                    <Checkbox
                        checked={showHidden}
                        onCheckedChange={(checked) =>
                            setShowHidden(checked === true)
                        }
                    />
                    Show hidden events
                </label>
            </div>

            <div className="space-y-2">
                {events.map((event, index) => {
                    const type = event.type || "unknown";
                    const isCollapsible = isCollapsibleEvent(event);
                    const isHidden = isCollapsible && !showHidden;
                    const isExpanded = expandedEvents.has(index);
                    const borderColor = getEventBorderColor(type);
                    const label = getEventLabel(event);

                    // 调试：记录渲染决策
                    if (type === "tool-call") {
                        console.log(
                            `[SSEResponseViewer] Rendering tool-call event #${index}:`,
                            {
                                type,
                                isCollapsible,
                                isHidden,
                                showHidden,
                                willRender: !isHidden,
                                event,
                            },
                        );
                    }

                    if (isHidden) return null;

                    const eventData = { ...event };
                    delete eventData.type;
                    delete eventData.timestamp;

                    return (
                        <div
                            key={index}
                            className={`rounded border-l-4 bg-white p-3 shadow-sm ${borderColor} ${
                                isCollapsible ? "cursor-pointer" : ""
                            }`}
                            onClick={
                                isCollapsible
                                    ? () => toggleEvent(index)
                                    : undefined
                            }
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-bold uppercase text-slate-700">
                                        {type}
                                    </span>
                                    {label && (
                                        <Badge
                                            variant="secondary"
                                            className="text-[10px]"
                                        >
                                            {label}
                                        </Badge>
                                    )}
                                    {isCollapsible && (
                                        <span className="text-xs text-slate-400">
                                            {isExpanded ? "▼" : "▶"}
                                        </span>
                                    )}
                                </div>
                                {event.timestamp && (
                                    <span className="text-xs text-slate-400">
                                        {new Date(
                                            event.timestamp,
                                        ).toLocaleTimeString()}
                                    </span>
                                )}
                                <CopyChunkButton
                                    getData={() =>
                                        JSON.stringify(eventData, null, 2)
                                    }
                                />
                            </div>

                            {(!isCollapsible || isExpanded) && (
                                <div className="mt-2">
                                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">
                                        {highlightImportantKeys(eventData)
                                            .split("\n")
                                            .map((line, i) => {
                                                const match =
                                                    line.match(
                                                        /\*\*"(.+?)"\*\*/,
                                                    );
                                                if (match) {
                                                    const parts =
                                                        line.split(
                                                            /\*\*"(.+?)"\*\*/,
                                                        );
                                                    return (
                                                        <div
                                                            key={i}
                                                            className="break-words"
                                                        >
                                                            {parts.map(
                                                                (part, j) =>
                                                                    j % 2 ===
                                                                    1 ? (
                                                                        <strong
                                                                            key={
                                                                                j
                                                                            }
                                                                            className="rounded bg-slate-200 px-1"
                                                                        >
                                                                            &quot;
                                                                            {
                                                                                part
                                                                            }
                                                                            &quot;
                                                                        </strong>
                                                                    ) : (
                                                                        part
                                                                    ),
                                                            )}
                                                        </div>
                                                    );
                                                }
                                                return (
                                                    <div
                                                        key={i}
                                                        className="break-words"
                                                    >
                                                        {line}
                                                    </div>
                                                );
                                            })}
                                    </pre>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Voice Agent Response Viewer
interface VoiceAgentMessage {
    role: string;
    content?: string;
    tool_calls?: Array<{
        id: string;
        type?: string;
        function: {
            name: string;
            arguments: string | Record<string, unknown>;
        };
    }>;
    tool_call_id?: string;
}

function VoiceAgentResponseViewer({
    responseContent,
}: {
    responseContent: string;
}) {
    const [expandedEvents, setExpandedEvents] = useState<Set<number>>(
        new Set(),
    );

    const { messages: parsed, raw } = useMemo(() => {
        try {
            const data = JSON.parse(responseContent) as Record<string, unknown>;
            // 支持 { messages: [...] } 和 { data: { messages: [...] } } 两种结构
            const messages =
                (data.messages as VoiceAgentMessage[] | undefined) ??
                ((data.data as Record<string, unknown> | undefined)?.messages as
                    | VoiceAgentMessage[]
                    | undefined) ??
                [];
            return { messages, raw: JSON.stringify(data, null, 2) };
        } catch {
            return {
                messages: [] as VoiceAgentMessage[],
                raw: responseContent,
            };
        }
    }, [responseContent]);

    // 将 messages 拆成与 SSE 类似的 event 列表
    const events = useMemo(() => {
        const result: Array<{
            type: string;
            label: string | null;
            borderColor: string;
            collapsible: boolean;
            summary?: string;
            detail?: unknown;
        }> = [];

        for (const msg of parsed) {
            if (msg.role === "assistant" && msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    let args: unknown;
                    if (typeof tc.function.arguments === "string") {
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = tc.function.arguments;
                        }
                    } else {
                        args = tc.function.arguments;
                    }
                    result.push({
                        type: "tool-call",
                        label: tc.function.name,
                        borderColor: "border-cyan-500",
                        collapsible: true,
                        detail: {
                            toolName: tc.function.name,
                            id: tc.id,
                            input: args,
                        },
                    });
                }
            }
            if (msg.role === "tool") {
                let output: unknown;
                if (typeof msg.content === "string") {
                    try {
                        output = JSON.parse(msg.content);
                    } catch {
                        output = msg.content;
                    }
                } else {
                    output = msg.content;
                }
                result.push({
                    type: "tool-result",
                    label: msg.tool_call_id ?? null,
                    borderColor: "border-green-500",
                    collapsible: true,
                    detail: { toolCallId: msg.tool_call_id, output },
                });
            }
            if (msg.role === "assistant" && msg.content) {
                result.push({
                    type: "text",
                    label: null,
                    borderColor: "border-orange-500",
                    collapsible: false,
                    summary: msg.content,
                });
            }
        }
        return result;
    }, [parsed]);

    // 默认展开所有 collapsible 事件
    useEffect(() => {
        const all = new Set<number>();
        events.forEach((e, i) => {
            if (e.collapsible) all.add(i);
        });
        setExpandedEvents(all);
    }, [events]);

    const toggleEvent = useCallback((index: number) => {
        setExpandedEvents((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    if (parsed.length === 0) {
        return (
            <div className="space-y-2">
                <div className="text-xs text-slate-500">
                    No <code>messages</code> array found. Raw response:
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg border bg-slate-950/90 px-4 py-3 text-xs text-slate-100">
                    {raw}
                </pre>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                    Voice Agent
                </Badge>
                <Badge variant="secondary" className="text-xs">
                    {events.length} events
                </Badge>
            </div>

            <div className="space-y-2">
                {events.map((event, index) => {
                    const isExpanded = expandedEvents.has(index);

                    return (
                        <div
                            key={index}
                            className={`rounded border-l-4 bg-white p-3 shadow-sm ${event.borderColor} ${
                                event.collapsible ? "cursor-pointer" : ""
                            }`}
                            onClick={
                                event.collapsible
                                    ? () => toggleEvent(index)
                                    : undefined
                            }
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-bold uppercase text-slate-700">
                                        {event.type}
                                    </span>
                                    {event.label && (
                                        <Badge
                                            variant="secondary"
                                            className="text-[10px]"
                                        >
                                            {event.label}
                                        </Badge>
                                    )}
                                    {event.collapsible && (
                                        <span className="text-xs text-slate-400">
                                            {isExpanded ? "▼" : "▶"}
                                        </span>
                                    )}
                                </div>
                                <CopyChunkButton
                                    getData={() =>
                                        event.summary
                                            ? event.summary
                                            : JSON.stringify(
                                                  event.detail,
                                                  null,
                                                  2,
                                              )
                                    }
                                />
                            </div>

                            {event.type === "text" && event.summary && (
                                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-800">
                                    {event.summary}
                                </div>
                            )}

                            {event.collapsible &&
                            isExpanded &&
                            event.detail != null ? (
                                <div className="mt-2">
                                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">
                                        {highlightImportantKeys(event.detail)
                                            .split("\n")
                                            .map((line, i) => {
                                                const match =
                                                    line.match(
                                                        /\*\*"(.+?)"\*\*/,
                                                    );
                                                if (match) {
                                                    const parts =
                                                        line.split(
                                                            /\*\*"(.+?)"\*\*/,
                                                        );
                                                    return (
                                                        <div
                                                            key={i}
                                                            className="break-words"
                                                        >
                                                            {parts.map(
                                                                (part, j) =>
                                                                    j % 2 ===
                                                                    1 ? (
                                                                        <strong
                                                                            key={
                                                                                j
                                                                            }
                                                                            className="rounded bg-slate-200 px-1"
                                                                        >
                                                                            &quot;
                                                                            {
                                                                                part
                                                                            }
                                                                            &quot;
                                                                        </strong>
                                                                    ) : (
                                                                        part
                                                                    ),
                                                            )}
                                                        </div>
                                                    );
                                                }
                                                return (
                                                    <div
                                                        key={i}
                                                        className="break-words"
                                                    >
                                                        {line}
                                                    </div>
                                                );
                                            })}
                                    </pre>
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Batch Add Cases Dialog Component
type ParsedCase = {
    userMessage: string;
    evalRule: string;
    title: string; // Auto-generated from userMessage
};

function BatchAddCasesDialog({
    open,
    onOpenChange,
    contextId,
    onSuccess,
    isBusy,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    contextId: string;
    onSuccess: () => Promise<void>;
    isBusy: boolean;
}) {
    const [file, setFile] = useState<File | null>(null);
    const [parsedCases, setParsedCases] = useState<ParsedCase[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Reset state when dialog closes
    useEffect(() => {
        if (!open) {
            setFile(null);
            setParsedCases([]);
            setParseError(null);
        }
    }, [open]);

    // Download sample CSV
    const handleDownloadSample = () => {
        const sampleCSV = `userMessage,Evaluation Rule
帮我查询今天的天气,Response should contain weather information
解释什么是机器学习,Response should explain machine learning concepts clearly
翻译这段文字到英文,Response should provide accurate English translation`;

        const blob = new Blob([sampleCSV], { type: "text/csv;charset=utf-8;" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "batch_cases_sample.csv";
        link.click();
        URL.revokeObjectURL(link.href);
    };

    // Parse CSV file
    const parseCSV = (text: string): ParsedCase[] => {
        const lines = text.split("\n").filter((line) => line.trim());

        if (lines.length < 2) {
            throw new Error(
                "CSV file must contain at least a header row and one data row",
            );
        }

        // Validate header
        const header = lines[0].toLowerCase();
        if (
            !header.includes("usermessage") ||
            !header.includes("evaluation rule")
        ) {
            throw new Error(
                'CSV header must contain "userMessage" and "Evaluation Rule" columns',
            );
        }

        // Parse data rows
        const cases: ParsedCase[] = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Simple CSV parsing (handles quotes)
            const parts: string[] = [];
            let current = "";
            let inQuotes = false;

            for (let j = 0; j < line.length; j++) {
                const char = line[j];

                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === "," && !inQuotes) {
                    parts.push(current.trim());
                    current = "";
                } else {
                    current += char;
                }
            }
            parts.push(current.trim());

            if (parts.length !== 2) {
                throw new Error(
                    `Row ${i + 1}: Expected 2 columns, found ${parts.length}`,
                );
            }

            const [userMessage, evalRule] = parts.map((p) =>
                p.replace(/^"|"$/g, ""),
            );

            if (!userMessage) {
                throw new Error(`Row ${i + 1}: userMessage cannot be empty`);
            }

            // Generate title from userMessage (first line, max 50 chars)
            const firstLine = userMessage.split("\n")[0];
            const title =
                firstLine.length > 50
                    ? firstLine.substring(0, 50) + "..."
                    : firstLine;

            cases.push({
                userMessage,
                evalRule: evalRule || "",
                title,
            });
        }

        return cases;
    };

    // Handle file selection
    const handleFileChange = async (selectedFile: File | null) => {
        if (!selectedFile) return;

        setFile(selectedFile);
        setParseError(null);
        setParsedCases([]);

        try {
            const text = await selectedFile.text();
            const cases = parseCSV(text);
            setParsedCases(cases);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to parse CSV file";
            setParseError(message);
            toast.error(message);
        }
    };

    // Handle drag and drop
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const droppedFile = e.dataTransfer.files[0];
        if (droppedFile && droppedFile.type === "text/csv") {
            void handleFileChange(droppedFile);
        } else {
            toast.error("Please drop a CSV file");
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    // Submit batch creation
    const handleSubmit = async () => {
        if (!parsedCases.length) return;

        setIsUploading(true);
        try {
            const response = await fetch("/api/evaluations/cases/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contextId,
                    cases: parsedCases.map((c) => ({
                        userMessage: c.userMessage,
                        evalRule: c.evalRule,
                    })),
                }),
            });

            if (!response.ok) {
                const error = (await response.json()) as { error?: string };
                throw new Error(error.error || "Failed to create cases");
            }

            const result = (await response.json()) as {
                created: number;
                failed: number;
                errors?: Array<{ index: number; error: string }>;
            };

            if (result.failed > 0 && result.errors) {
                toast.error(
                    `Created ${result.created} cases, but ${result.failed} failed`,
                );
                console.error("Failed cases:", result.errors);
            } else {
                toast.success(`Successfully created ${result.created} cases`);
            }

            await onSuccess();
            onOpenChange(false);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to create cases";
            toast.error(message);
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>Batch Add Cases</DialogTitle>
                    <DialogDescription>
                        Upload a CSV file to batch create evaluation cases.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Download Sample Button */}
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleDownloadSample}
                        >
                            <Download className="mr-2 size-4" />
                            Download Sample CSV
                        </Button>
                    </div>

                    {/* File Upload Area */}
                    <div
                        className={cn(
                            "border-2 border-dashed rounded-lg p-8 text-center transition-colors",
                            parseError
                                ? "border-red-300 bg-red-50"
                                : parsedCases.length > 0
                                  ? "border-green-300 bg-green-50"
                                  : "border-slate-300 bg-slate-50 hover:border-slate-400",
                        )}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv"
                            className="hidden"
                            onChange={(e) =>
                                void handleFileChange(
                                    e.target.files?.[0] || null,
                                )
                            }
                        />

                        <Upload className="mx-auto size-12 text-slate-400 mb-4" />

                        {file ? (
                            <div className="space-y-2">
                                <p className="text-sm font-medium text-slate-900">
                                    {file.name}
                                </p>
                                {parseError ? (
                                    <p className="text-sm text-red-600">
                                        {parseError}
                                    </p>
                                ) : parsedCases.length > 0 ? (
                                    <p className="text-sm text-green-600">
                                        ✓ Parsed {parsedCases.length} cases
                                        successfully
                                    </p>
                                ) : null}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <p className="text-sm text-slate-600">
                                    Drag and drop your CSV file here, or{" "}
                                    <button
                                        type="button"
                                        className="text-primary underline underline-offset-2"
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                    >
                                        browse
                                    </button>
                                </p>
                                <p className="text-xs text-slate-500">
                                    CSV should have columns: userMessage,
                                    Evaluation Rule
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Preview Table */}
                    {parsedCases.length > 0 && !parseError && (
                        <div className="space-y-2">
                            <h4 className="text-sm font-semibold text-slate-700">
                                Preview ({parsedCases.length} cases)
                            </h4>
                            <div className="max-h-96 overflow-auto border rounded-lg">
                                <table className="w-full text-sm">
                                    <thead className="bg-slate-100 sticky top-0">
                                        <tr>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700 w-16">
                                                #
                                            </th>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700">
                                                Title (Auto-generated)
                                            </th>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700">
                                                User Message
                                            </th>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700">
                                                Eval Rule
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {parsedCases.map((caseData, index) => (
                                            <tr
                                                key={index}
                                                className="border-t hover:bg-slate-50"
                                            >
                                                <td className="px-3 py-2 text-slate-500">
                                                    {index + 1}
                                                </td>
                                                <td className="px-3 py-2 text-slate-900 font-medium">
                                                    {caseData.title}
                                                </td>
                                                <td className="px-3 py-2 text-slate-700 max-w-md truncate">
                                                    {caseData.userMessage}
                                                </td>
                                                <td className="px-3 py-2 text-slate-600 max-w-xs truncate">
                                                    {caseData.evalRule || (
                                                        <span className="text-slate-400 italic">
                                                            None
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={isUploading}
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={
                            parsedCases.length === 0 || isUploading || isBusy
                        }
                        onClick={() => void handleSubmit()}
                    >
                        {isUploading
                            ? "Creating..."
                            : `Create ${parsedCases.length} Cases`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
