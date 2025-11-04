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
    EvaluationCase,
    EvaluationContext,
    EvaluationVersion,
    RunSummary,
} from "@/lib/evaluations/models";
import { cn } from "@/lib/utils";
import { MessageBuilder } from "@/components/evaluations/message-builder";

type SelectedNode =
    | { type: "version" }
    | { type: "context"; contextId: string }
    | { type: "case"; contextId: string; caseId: string };

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
const calculateContextScore = (
    context: EvaluationContext
): ScoreStats => {
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
const calculateVersionScore = (
    version: EvaluationVersion
): ScoreStats => {
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
    environment: EvaluationContext["environment"],
    resolvedMessages: EvaluationContext["resolvedMessages"],
    userMessage: EvaluationCase["userMessage"],
    headers: EvaluationContext["headers"],
    traceId: string,
): Record<string, unknown> => {
    const agentMessage = createAgentRecentMessage(userMessage);
    if (!agentMessage) {
        throw new Error("User message is empty.");
    }

    // 使用当前 Context 的完整 environment（已经包含了从父节点拷贝的所有配置）
    const envData = cloneData(environment ?? {}) as Record<string, unknown>;

    // 从 envData 中移除 recent_messages，因为要单独处理
    delete envData["recent_messages"];

    // 构建正确的请求格式
    // environment: 使用当前 Context 的完整 environment（创建时已从父节点深拷贝）
    // recent_messages: 使用 resolvedMessages（递归合并的完整消息历史）
    const payload: Record<string, unknown> = {
        environment: envData,
        recent_messages: [...cloneData(resolvedMessages as unknown[]), agentMessage],
    };

    return payload;
};

const buildAgentRequestHeaders = (
    headers: EvaluationContext["headers"],
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
    merged[TRACE_ID_HEADER] = traceId;
    return merged;
};

const RUN_CONFIG_STORAGE_KEY = "evaluation-run-config-v2";

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
            ? { type: "context", contextId: initialVersions[0].rootContexts[0].id }
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
    const [isMutating, setIsMutating] = useState(false);
    const [isRunConfigDialogOpen, setRunConfigDialogOpen] = useState(false);
    const [isVersionDialogOpen, setVersionDialogOpen] = useState(false);
    const [isContextDialogOpen, setContextDialogOpen] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
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
                        const updatedChildren = context.children.map(
                            updateContextTree,
                        );

                        return {
                            ...context,
                            cases: updatedCases,
                            children: updatedChildren,
                        };
                    };

                    return {
                        ...version,
                        rootContexts: version.rootContexts.map(updateContextTree),
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

    const isBusy = isMutating || isRefreshing;

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
        if (isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to create version";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const openCaseEditor = useCallback((contextId: string, caseId: string) => {
        setCaseDialogTarget({ contextId, caseId });
        setCaseDialogOpen(true);
    }, []);

    const handleDuplicateVersion = async (version: EvaluationVersion) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to duplicate version";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleDeleteVersion = async (versionId: string) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
            await apiRequest(`/api/evaluations/versions/${versionId}`, {
                method: "DELETE",
            });
            if (activeVersionId === versionId) {
                setActiveVersionId(null);
            }
            setSelectedNode({ type: "version" });
            await refreshTree();
            toast.success("Deleted version");
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to delete version";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleUpdateVersion = async (
        versionId: string,
        updates: Partial<EvaluationVersion>,
    ) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
            await apiRequest(`/api/evaluations/versions/${versionId}`, {
                method: "PATCH",
                body: JSON.stringify({
                    label: updates.label,
                    notes: updates.notes ?? null,
                    agentBaseUrl: updates.agentBaseUrl ?? null,
                }),
            });
            await refreshTree();
            toast.success("Saved version changes");
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to save version";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleAddContext = async () => {
        if (!activeVersion || isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to create context";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleUpdateContext = async (
        contextId: string,
        updates: Partial<EvaluationContext>,
    ) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
            await apiRequest(`/api/evaluations/contexts/${contextId}`, {
                method: "PATCH",
                body: JSON.stringify({
                    name: updates.name,
                    description: updates.description ?? null,
                    environment: updates.environment,
                    headers: updates.headers,
                }),
            });
            await refreshTree();
            toast.success("Saved context changes");
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to save context";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleDeleteContext = async (context: EvaluationContext) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to delete context";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleAddCase = async (contextId: string) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to create case";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleUpdateCase = async (
        contextId: string,
        caseId: string,
        updates: Partial<EvaluationCase>,
    ) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to save case";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const handleDeleteCase = async (
        contextId: string,
        testCase: EvaluationCase,
    ) => {
        if (isMutating) return;
        setIsMutating(true);
        try {
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
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to delete case";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const gatherCasesForRun = (trigger: RunTrigger): CaseExecutionTarget[] => {
        if (!activeVersion) return [];

        const targetedCases = new Map<string, CaseExecutionTarget>();

        // Helper: Recursively collect all contexts including children
        const getAllContexts = (contexts: EvaluationContext[]): EvaluationContext[] => {
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

        const addContextCases = (context?: EvaluationContext) => {
            if (!context) return;
            context.cases?.forEach((testCase) => {
                targetedCases.set(testCase.id, { context, testCase });
            });
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
                addContextCases(findContextById(trigger.contextId));
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

    const runCases = async (trigger: RunTrigger, friendlyLabel: string) => {
        // If already running, abort the current run
        if (isRunning && abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsRunning(false);
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

        if (isMutating) return;

        // Create new AbortController for this run
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        setIsMutating(true);
        setIsRunning(true);

        let loadingToastId: string | undefined;

        try {
            const versionId = activeVersion.id;
            const agentEndpoint = `${normalizeAgentBaseUrl(
                activeVersion.agentBaseUrl,
            )}${AGENT_STREAM_PATH}`;

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
                        context.headers,
                        traceId,
                    );
                    const requestBody = buildAgentRequestBody(
                        context.environment,
                        context.resolvedMessages,
                        testCase.userMessage,
                        context.headers,
                        traceId,
                    );

                    let response: Response;
                    try {
                        response = await fetch(agentEndpoint, {
                            method: "POST",
                            body: JSON.stringify(requestBody),
                            headers,
                            signal: abortController.signal,
                        });
                    } catch (fetchError) {
                        // Check if this was an abort
                        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
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

                    const reader = response.body?.getReader();
                    if (!reader) {
                        throw new Error(
                            "No response body reader available from agent.",
                        );
                    }

                    const decoder = new TextDecoder();
                    let responseContent = "";
                    let done = false;
                    while (!done) {
                        const { value, done: readerDone } = await reader.read();
                        if (value) {
                            const chunk = decoder.decode(value, { stream: !readerDone });
                            responseContent += chunk;
                        }
                        done = readerDone;
                    }
                    // Final flush of decoder
                    responseContent += decoder.decode();

                    const durationMs = Math.round(performance.now() - startedAt);
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
                        console.log(`✅ [SaveResult] Case ${testCase.id} result saved successfully`);
                    } catch (saveError) {
                        console.error("❌ [SaveResult] Failed to save result:", saveError);

                        // 保存失败：更新前端状态为失败
                        updateCaseRunSummary(versionId, context.id, testCase.id, {
                            status: "failed",
                            durationMs,
                            completedAt,
                        });

                        // 计算响应大小并显示警告
                        const responseSizeKB = Math.round(responseContent.length / 1024);
                        const errorMsg = saveError instanceof Error ? saveError.message : String(saveError);

                        toast.error(
                            `Failed to save case result (${responseSizeKB}KB). ${errorMsg}. ` +
                            "Evaluation skipped to maintain data consistency.",
                            { duration: 6000 }
                        );
                    }

                    // 只有保存成功才执行评估
                    if (savedSuccessfully && testCase.evalRule && testCase.evalRule.trim()) {
                        console.log(`[Auto-evaluate] Evaluating case ${testCase.id} with evalRule...`);
                        try {
                            const evalResponse = await apiRequest(
                                `/api/evaluations/cases/${testCase.id}/evaluate`,
                                {
                                    method: "POST",
                                    body: JSON.stringify({ versionId }),
                                }
                            );

                            const evalResult = evalResponse as {
                                resultOverview?: string;
                                score?: number;
                            };

                            // 更新前端状态显示评估结果
                            if (evalResult.resultOverview !== undefined && evalResult.score !== undefined) {
                                updateCaseRunSummary(versionId, context.id, testCase.id, {
                                    status: "succeeded",
                                    durationMs,
                                    completedAt,
                                    responseContent,
                                    resultOverview: evalResult.resultOverview,
                                    score: evalResult.score,
                                });
                                console.log(`[Auto-evaluate] Evaluation complete. Score: ${evalResult.score}`);
                            }
                        } catch (evalError) {
                            console.error(`[Auto-evaluate] Failed to evaluate case ${testCase.id}:`, evalError);
                            // 评估失败不影响主流程，只记录错误
                        }
                    }
                } catch (error) {
                    const durationMs = Math.round(performance.now() - startedAt);
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
                                responseContent: "",  // 失败时没有响应内容
                                latencyMs: durationMs,
                                startedAt: new Date(startedAt).toISOString(),
                                completedAt,
                                error: message,
                            }),
                        });
                    } catch (saveError) {
                        console.error("Failed to save result to database:", saveError);
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

            if (successCount && !failureCount) {
                toast.success(
                    `Completed ${successCount} case(s) for ${friendlyLabel}.`,
                );
            } else if (!successCount && failureCount) {
                toast.error(
                    `Failed to run ${failureCount} case(s) for ${friendlyLabel}.`,
                );
            } else if (successCount && failureCount) {
                toast(
                    `Completed ${successCount} case(s) with ${failureCount} failure(s) for ${friendlyLabel}.`,
                );
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
            if (error instanceof Error && error.name === 'AbortError') {
                toast('Run stopped by user', { duration: 3000 });
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
            setIsMutating(false);
            setIsRunning(false);
            abortControllerRef.current = null;
        }
    };

    const contextSelectionState = (context: EvaluationContext) => {
        const totalCases = context.cases?.length || 0;
        const selectedCases = context.cases?.filter((testCase) =>
            checkedCaseIds.has(testCase.id),
        ).length || 0;
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
                            variant={isRunning ? "destructive" : "default"}
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
                                );
                            }}
                            disabled={
                                !activeVersion ||
                                (!selectedContextCount && !selectedCaseCount && !isRunning) ||
                                (isBusy && !isRunning)
                            }
                        >
                            {isRunning ? (
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
                                            variant={isRunning ? "destructive" : "default"}
                                            className="rounded-none rounded-l-md"
                                            disabled={
                                                (!canRunSelection && !isRunning) ||
                                                !activeVersion ||
                                                (isBusy && !isRunning)
                                            }
                                            onClick={() => {
                                                if (
                                                    !activeVersion ||
                                                    (!canRunSelection && !isRunning)
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
                                                );
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
                                    )
                                }
                            />
                        ) : null}

                        {selectedNode.type === "context" && selectedContext ? (
                            <ContextSummary
                                context={selectedContext}
                                isBusy={isBusy}
                                isRunning={isRunning}
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

                        {selectedCase &&
                        selectedContext ? (
                            <CaseSummary
                                context={selectedContext}
                                testCase={selectedCase}
                                isBusy={isBusy}
                                isRunning={isRunning}
                                onRun={() =>
                                    runCases(
                                        {
                                            kind: "case",
                                            versionId: activeVersion.id,
                                            contextId: selectedContext.id,
                                            caseId: selectedCase.id,
                                        },
                                        `case ${selectedCase.title}`,
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
                        Configure concurrency for evaluation runs. All selected cases will be executed.
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
                            downstream agent. Click the Run button again during execution to stop.
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
                        value={formatPassRate(scoreStats.passCount, scoreStats.scoredItems)}
                    />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <StatTile
                        label="Agent endpoint"
                        value={version.agentBaseUrl ?? "—"}
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
                                    {(context.cases?.length || 0) === 1 ? "" : "s"}
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

    useEffect(() => {
        if (!open) return;
        setLabel(version.label);
        setNotes(version.notes ?? "");
        setAgentBaseUrl(version.agentBaseUrl ?? "");
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

        await onSave({
            label,
            notes,
            agentBaseUrl,
        });
        onOpenChange(false);
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
                                placeholder="https://example.com/agent"
                                value={agentBaseUrl}
                                onChange={(event) =>
                                    setAgentBaseUrl(event.target.value)
                                }
                            />
                        </div>
                    </div>
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
                }
            );

            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new Error(errorData.error || "Failed to generate summary");
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
                    : "Failed to generate summary"
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
                            This is a child context created from a case result.
                            It inherits configuration from its parent and stores incremental messages.
                        </div>
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
                <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Environment JSON
                        </h4>
                        <JsonViewer value={context.environment ?? {}} />
                    </div>
                    <div className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Headers JSON
                        </h4>
                        <JsonViewer value={context.headers ?? {}} />
                    </div>
                    <div className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Recent Messages
                        </h4>
                        <JsonViewer value={context.resolvedMessages ?? []} />
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
                                {isGeneratingSummary ? "Generating..." : "Generate"}
                            </Button>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm min-h-[100px]">
                            {context.contextSummary ? (
                                <MarkdownRenderer content={context.contextSummary} />
                            ) : (
                                <span className="text-slate-400 italic">No summary available</span>
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
                                    <span className="text-slate-600">Average Score:</span>
                                    <span className="font-semibold text-slate-900">
                                        {formatScore(scoreStats.averageScore)}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-slate-600">Scored:</span>
                                    <span className="font-semibold text-slate-900">
                                        {scoreStats.scoredItems}/{scoreStats.totalItems}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-slate-600">Pass Rate:</span>
                                    <span className="font-semibold text-slate-900">
                                        {formatPassRate(scoreStats.passCount, scoreStats.scoredItems)}
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
                                                        statusVariantMap[status]
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
                                        </div>
                                    </div>
                                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                                        <span>{completedAt}</span>
                                        {testCase.lastRunSummary?.durationMs ? (
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
    const [contextSummary, setContextSummary] = useState(context.contextSummary ?? "");
    const [environmentText, setEnvironmentText] = useState(
        JSON.stringify(context.environment ?? {}, null, 2),
    );
    const [headersText, setHeadersText] = useState(
        JSON.stringify(context.headers ?? {}, null, 2),
    );

    useEffect(() => {
        if (!open) return;
        setName(context.name);
        setDescription(context.description ?? "");
        setContextSummary(context.contextSummary ?? "");
        setEnvironmentText(
            JSON.stringify(context.environment ?? {}, null, 2),
        );
        setHeadersText(JSON.stringify(context.headers ?? {}, null, 2));
    }, [open, context]);

    const handleSave = async () => {
        let parsedEnvironment: Record<string, unknown> = {};
        let parsedHeaders: Record<string, string> = {};

        try {
            parsedEnvironment =
                environmentText.trim().length > 0 ? JSON.parse(environmentText) : {};
        } catch {
            toast.error("Environment JSON is invalid.");
            return;
        }

        try {
            parsedHeaders =
                headersText.trim().length > 0 ? JSON.parse(headersText) : {};
        } catch {
            toast.error("Headers JSON is invalid.");
            return;
        }

        await onSave({
            name,
            description,
            contextSummary,
            environment: parsedEnvironment,
            headers: parsedHeaders,
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>Edit context</DialogTitle>
                    <DialogDescription>
                        Adjust metadata, params, and headers for this context.
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
                    <div className="space-y-2">
                        <Label htmlFor="edit-context-environment">
                            Environment JSON
                        </Label>
                        <Textarea
                            id="edit-context-environment"
                            rows={8}
                            value={environmentText}
                            onChange={(event) =>
                                setEnvironmentText(event.target.value)
                            }
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="edit-context-headers">
                            Headers JSON
                        </Label>
                        <Textarea
                            id="edit-context-headers"
                            rows={5}
                            value={headersText}
                            onChange={(event) =>
                                setHeadersText(event.target.value)
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
    onRefresh,
    versionId,
}: {
    context: EvaluationContext;
    testCase: EvaluationCase;
    onRun: () => Promise<void>;
    onDelete: () => Promise<void>;
    onEdit: () => void;
    isBusy: boolean;
    isRunning: boolean;
    onRefresh: () => Promise<void>;
    versionId: string;
}) {
    const status = testCase.lastRunSummary?.status;
    const [isSaving, setIsSaving] = useState(false);
    const [isEvaluating, setIsEvaluating] = useState(false);

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
                }
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
                error instanceof Error
                    ? error.message
                    : "Failed to evaluate"
            );
        } finally {
            setIsEvaluating(false);
        }
    };

    const handleSaveToContext = async () => {
        if (!testCase.lastRunSummary?.responseContent) {
            toast.error("No response content to save");
            return;
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
                        responseContent: testCase.lastRunSummary.responseContent,
                        caseTitle: testCase.title,
                    }),
                }
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
                `✅ Created new context with ${result.messagesAdded} messages`
            );

            // 刷新数据以显示新创建的 context
            await onRefresh();
        } catch (error) {
            console.error("Failed to save to context:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to save to context"
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
                            <MarkdownRenderer content={context.contextSummary} />
                        ) : (
                            <span className="text-slate-400 italic">No summary available</span>
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
                            !testCase.evalRule ||
                            !testCase.lastRunSummary?.responseContent ||
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
                                    {testCase.lastRunSummary?.score !== undefined ? (
                                        <Badge variant="default" className="text-lg px-4 py-2">
                                            {testCase.lastRunSummary.score}
                                        </Badge>
                                    ) : (
                                        <span className="text-sm text-slate-400">-</span>
                                    )}
                                </div>
                            </div>

                            {/* Evaluation Rule */}
                            <div className="space-y-2 md:col-span-3">
                                <span className="text-sm font-semibold text-slate-700">
                                    Evaluation Rule
                                </span>
                                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900 whitespace-pre-wrap">
                                    {testCase.evalRule || (
                                        <span className="text-slate-400 italic">No evaluation rule defined</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Overview in full width row */}
                        <div className="space-y-2">
                            <span className="text-sm font-semibold text-slate-700">
                                Overview
                            </span>
                            <div className="rounded-md border border-slate-200 bg-white p-3 text-sm min-h-[60px]">
                                {testCase.lastRunSummary?.resultOverview ? (
                                    <MarkdownRenderer content={testCase.lastRunSummary.resultOverview} />
                                ) : (
                                    <span className="text-slate-400 italic">No overview available</span>
                                )}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
            {testCase.lastRunSummary?.responseContent ? (
                <Card>
                    <CardHeader>
                        <div className="flex items-start justify-between">
                            <div className="space-y-1">
                                <CardTitle>Response content</CardTitle>
                                <CardDescription>
                                    Stream response from the agent (session storage only, not persisted).
                                </CardDescription>
                            </div>
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
                        </div>
                    </CardHeader>
                    <CardContent>
                        <SSEResponseViewer
                            responseContent={
                                testCase.lastRunSummary.responseContent
                            }
                        />
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
    const [evalRule, setEvalRule] = useState(testCase.evalRule ?? "");

    useEffect(() => {
        if (!open) return;
        setTitle(testCase.title);
        setDescription(testCase.description ?? "");
        const content = testCase.userMessage.content;
        setUserMessageText(typeof content === "string" ? content : "");
        setEvalRule(testCase.evalRule ?? "");
    }, [open, testCase]);

    const handleSave = async () => {
        // 自动设置标题：如果是默认标题或为空，且 userMessage 有内容，则使用 userMessage 的第一行作为标题
        let finalTitle = title.trim();
        const trimmedMessage = userMessageText.trim();

        if ((!finalTitle || finalTitle === "New Case") && trimmedMessage) {
            // 取第一行或前 50 个字符作为标题
            const firstLine = trimmedMessage.split('\n')[0];
            finalTitle = firstLine.length > 50
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
            evalRule: evalRule || undefined,
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
                            Evaluation Rule (Optional)
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
            <div className="text-sm text-slate-500">
                No parts configured.
            </div>
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
    message:
        | EvaluationCase["userMessage"]
        | undefined;
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
        type === "tool-input-delta"
    );
}

function getEventBorderColor(type: string): string {
    if (type.includes("start")) return "border-blue-500";
    if (type.includes("finish") || type.includes("end"))
        return "border-purple-500";
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

    const events = useMemo(() => parseSSEResponse(responseContent), [
        responseContent,
    ]);
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
                            </div>

                            {(!isCollapsible || isExpanded) && (
                                <div className="mt-2">
                                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">
                                        {highlightImportantKeys(eventData)
                                            .split("\n")
                                            .map((line, i) => {
                                                const match =
                                                    line.match(/\*\*"(.+?)"\*\*/);
                                                if (match) {
                                                    const parts = line.split(
                                                        /\*\*"(.+?)"\*\*/,
                                                    );
                                                    return (
                                                        <div key={i} className="break-words">
                                                            {parts.map(
                                                                (part, j) =>
                                                                    j % 2 ===
                                                                    1 ? (
                                                                        <strong
                                                                            key={j}
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
                                                return <div key={i} className="break-words">{line}</div>;
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

        const blob = new Blob([sampleCSV], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'batch_cases_sample.csv';
        link.click();
        URL.revokeObjectURL(link.href);
    };

    // Parse CSV file
    const parseCSV = (text: string): ParsedCase[] => {
        const lines = text.split('\n').filter(line => line.trim());

        if (lines.length < 2) {
            throw new Error('CSV file must contain at least a header row and one data row');
        }

        // Validate header
        const header = lines[0].toLowerCase();
        if (!header.includes('usermessage') || !header.includes('evaluation rule')) {
            throw new Error('CSV header must contain "userMessage" and "Evaluation Rule" columns');
        }

        // Parse data rows
        const cases: ParsedCase[] = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Simple CSV parsing (handles quotes)
            const parts: string[] = [];
            let current = '';
            let inQuotes = false;

            for (let j = 0; j < line.length; j++) {
                const char = line[j];

                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    parts.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            parts.push(current.trim());

            if (parts.length !== 2) {
                throw new Error(`Row ${i + 1}: Expected 2 columns, found ${parts.length}`);
            }

            const [userMessage, evalRule] = parts.map(p => p.replace(/^"|"$/g, ''));

            if (!userMessage) {
                throw new Error(`Row ${i + 1}: userMessage cannot be empty`);
            }

            // Generate title from userMessage (first line, max 50 chars)
            const firstLine = userMessage.split('\n')[0];
            const title = firstLine.length > 50
                ? firstLine.substring(0, 50) + "..."
                : firstLine;

            cases.push({
                userMessage,
                evalRule: evalRule || '',
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
            const message = error instanceof Error ? error.message : 'Failed to parse CSV file';
            setParseError(message);
            toast.error(message);
        }
    };

    // Handle drag and drop
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const droppedFile = e.dataTransfer.files[0];
        if (droppedFile && droppedFile.type === 'text/csv') {
            void handleFileChange(droppedFile);
        } else {
            toast.error('Please drop a CSV file');
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
            const response = await fetch('/api/evaluations/cases/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contextId,
                    cases: parsedCases.map(c => ({
                        userMessage: c.userMessage,
                        evalRule: c.evalRule,
                    })),
                }),
            });

            if (!response.ok) {
                const error = (await response.json()) as { error?: string };
                throw new Error(error.error || 'Failed to create cases');
            }

            const result = (await response.json()) as {
                created: number;
                failed: number;
                errors?: Array<{ index: number; error: string }>;
            };

            if (result.failed > 0 && result.errors) {
                toast.error(`Created ${result.created} cases, but ${result.failed} failed`);
                console.error('Failed cases:', result.errors);
            } else {
                toast.success(`Successfully created ${result.created} cases`);
            }

            await onSuccess();
            onOpenChange(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to create cases';
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
                                  : "border-slate-300 bg-slate-50 hover:border-slate-400"
                        )}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv"
                            className="hidden"
                            onChange={(e) => void handleFileChange(e.target.files?.[0] || null)}
                        />

                        <Upload className="mx-auto size-12 text-slate-400 mb-4" />

                        {file ? (
                            <div className="space-y-2">
                                <p className="text-sm font-medium text-slate-900">
                                    {file.name}
                                </p>
                                {parseError ? (
                                    <p className="text-sm text-red-600">{parseError}</p>
                                ) : parsedCases.length > 0 ? (
                                    <p className="text-sm text-green-600">
                                        ✓ Parsed {parsedCases.length} cases successfully
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
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        browse
                                    </button>
                                </p>
                                <p className="text-xs text-slate-500">
                                    CSV should have columns: userMessage, Evaluation Rule
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
                                            <th className="px-3 py-2 text-left font-medium text-slate-700 w-16">#</th>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700">Title (Auto-generated)</th>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700">User Message</th>
                                            <th className="px-3 py-2 text-left font-medium text-slate-700">Eval Rule</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {parsedCases.map((caseData, index) => (
                                            <tr key={index} className="border-t hover:bg-slate-50">
                                                <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                                                <td className="px-3 py-2 text-slate-900 font-medium">{caseData.title}</td>
                                                <td className="px-3 py-2 text-slate-700 max-w-md truncate">
                                                    {caseData.userMessage}
                                                </td>
                                                <td className="px-3 py-2 text-slate-600 max-w-xs truncate">
                                                    {caseData.evalRule || <span className="text-slate-400 italic">None</span>}
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
                        disabled={parsedCases.length === 0 || isUploading || isBusy}
                        onClick={() => void handleSubmit()}
                    >
                        {isUploading ? 'Creating...' : `Create ${parsedCases.length} Cases`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
