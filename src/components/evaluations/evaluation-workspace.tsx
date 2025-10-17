"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import {
    ChevronDown,
    ChevronRight,
    Clock,
    Database,
    Play,
    Plus,
    Settings2,
    Trash2,
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
import type {
    EvaluationCase,
    EvaluationContext,
    EvaluationVersion,
} from "@/lib/evaluations/models";
import { cn } from "@/lib/utils";
import { MessageBuilder } from "@/components/evaluations/message-builder";

type SelectedNode =
    | { type: "version" }
    | { type: "context"; contextId: string }
    | { type: "case"; contextId: string; caseId: string };

type RunConfig = {
    maxCasesPerRun: number;
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
    succeeded: "Succeeded",
    pending: "Pending",
    running: "Running",
    failed: "Failed",
    timeout: "Timeout",
};

const cloneData = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

interface EvaluationWorkspaceProps {
    initialVersions: EvaluationVersion[];
}

export function EvaluationWorkspace({
    initialVersions,
}: EvaluationWorkspaceProps) {
    const [versionsState, setVersionsState] = useState<EvaluationVersion[]>(
        () => cloneData(initialVersions),
    );
    const [activeVersionId, setActiveVersionId] = useState<string | null>(
        initialVersions[0]?.id ?? null,
    );
    const [selectedNode, setSelectedNode] = useState<SelectedNode>(() =>
        initialVersions[0]?.contexts?.[0]
            ? { type: "context", contextId: initialVersions[0].contexts[0].id }
            : { type: "version" },
    );
    const [checkedContextIds, setCheckedContextIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [checkedCaseIds, setCheckedCaseIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [runConfig, setRunConfig] = useState<RunConfig>({
        maxCasesPerRun: 10,
        concurrentRequests: 4,
    });
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isMutating, setIsMutating] = useState(false);

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

        versions.forEach((version) => {
            version.contexts.forEach((context) => {
                validContexts.add(context.id);
                context.cases.forEach((testCase) => {
                    validCases.add(testCase.id);
                });
            });
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
        setVersionsState(cloneData(initialVersions));
        sanitizeSelections(initialVersions);
    }, [initialVersions, sanitizeSelections]);
    const activeVersion = useMemo(() => {
        if (!activeVersionId) return undefined;
        return versionsState.find((version) => version.id === activeVersionId);
    }, [versionsState, activeVersionId]);

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
            const context = activeVersion.contexts.find(
                (ctx) => ctx.id === current.contextId,
            );
            if (!context) {
                const fallbackContext = activeVersion.contexts[0];
                return fallbackContext
                    ? { type: "context", contextId: fallbackContext.id }
                    : { type: "version" };
            }
            if (current.type === "case") {
                const caseExists = context.cases.some(
                    (testCase) => testCase.id === current.caseId,
                );
                if (!caseExists) {
                    return context.cases[0]
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

    const selectedContext =
        selectedNode.type === "context" || selectedNode.type === "case"
            ? activeVersion?.contexts.find(
                  (ctx) => ctx.id === selectedNode.contextId,
              )
            : undefined;

    const selectedCase =
        selectedNode.type === "case" && selectedContext
            ? selectedContext.cases.find(
                  (testCase) => testCase.id === selectedNode.caseId,
              )
            : undefined;

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
            context.cases.forEach((testCase) => {
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
            if (data?.id) {
                setActiveVersionId(data.id);
                setSelectedNode({ type: "version" });
            }
            await refreshTree();
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
                    params: updates.params,
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
                context.cases.forEach((testCase) => next.delete(testCase.id));
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
                    body: JSON.stringify({ contextId }),
                },
            );
            if (data?.id) {
                setSelectedNode({
                    type: "case",
                    contextId,
                    caseId: data.id,
                });
            }
            await refreshTree();
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
                    assistantMessage: updates.assistantMessage,
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

    const gatherCasesForRun = (trigger: RunTrigger): EvaluationCase[] => {
        if (!activeVersion) return [];

        if (trigger.kind === "version") {
            return activeVersion.contexts.flatMap((context) => context.cases);
        }

        if (trigger.kind === "context") {
            const context = activeVersion.contexts.find(
                (ctx) => ctx.id === trigger.contextId,
            );
            return context ? context.cases : [];
        }

        if (trigger.kind === "case") {
            const context = activeVersion.contexts.find(
                (ctx) => ctx.id === trigger.contextId,
            );
            const found = context?.cases.find(
                (testCase) => testCase.id === trigger.caseId,
            );
            return found ? [found] : [];
        }

        const targetedCases = new Map<string, EvaluationCase>();
        trigger.contextIds.forEach((contextId) => {
            const context = activeVersion.contexts.find(
                (ctx) => ctx.id === contextId,
            );
            context?.cases.forEach((testCase) => {
                targetedCases.set(testCase.id, testCase);
            });
        });
        trigger.caseIds.forEach((caseId) => {
            activeVersion.contexts.forEach((context) => {
                const testCase = context.cases.find(
                    (item) => item.id === caseId,
                );
                if (testCase) {
                    targetedCases.set(caseId, testCase);
                }
            });
        });
        return Array.from(targetedCases.values());
    };

    const runCases = async (trigger: RunTrigger, friendlyLabel: string) => {
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
        setIsMutating(true);
        try {
            let contextIds: string[] | undefined;
            let caseIds: string[] | undefined;

            switch (trigger.kind) {
                case "version":
                    contextIds = undefined;
                    caseIds = undefined;
                    break;
                case "context":
                    contextIds = [trigger.contextId];
                    break;
                case "case":
                    contextIds = [trigger.contextId];
                    caseIds = [trigger.caseId];
                    break;
                case "selection":
                    contextIds =
                        trigger.contextIds.length > 0
                            ? trigger.contextIds
                            : undefined;
                    caseIds =
                        trigger.caseIds.length > 0
                            ? trigger.caseIds
                            : undefined;
                    break;
            }

            const { data } = await apiRequest<{
                data: { runId: string; caseCount: number };
            }>("/api/evaluations/run", {
                method: "POST",
                body: JSON.stringify({
                    versionId: activeVersion.id,
                    contextIds,
                    caseIds,
                    maxCasesPerRun: runConfig.maxCasesPerRun,
                    concurrentRequests: runConfig.concurrentRequests,
                }),
            });

            await refreshTree();

            if (data?.runId) {
                toast.success(
                    `Run ${data.runId} completed for ${data.caseCount} case(s) in ${friendlyLabel}.`,
                );
            } else {
                toast.success(
                    `Queued ${targets.length} case(s) for ${friendlyLabel}.`,
                );
            }
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to run evaluations";
            toast.error(message);
        } finally {
            setIsMutating(false);
        }
    };

    const contextSelectionState = (context: EvaluationContext) => {
        const totalCases = context.cases.length;
        const selectedCases = context.cases.filter((testCase) =>
            checkedCaseIds.has(testCase.id),
        ).length;
        if (checkedContextIds.has(context.id)) return true;
        if (selectedCases > 0 && selectedCases < totalCases)
            return "indeterminate";
        if (selectedCases > 0 && totalCases === 0) return true;
        return selectedCases > 0 ? true : false;
    };

    const selectedContextCount = checkedContextIds.size;
    const selectedCaseCount = checkedCaseIds.size;

    return (
        <div className="flex h-[calc(100vh-4rem)] min-h-[560px] overflow-hidden rounded-2xl border bg-white shadow-sm">
            <aside className="w-80 border-r bg-slate-50">
                <div className="border-b p-4 space-y-3">
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
                            variant="default"
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
                                (!selectedContextCount && !selectedCaseCount) ||
                                isBusy
                            }
                        >
                            <Play className="mr-2 size-4" />
                            Run Selected
                        </Button>
                    </div>
                </div>

                <div className="p-4 space-y-3">
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
                    <div className="space-y-2">
                        {activeVersion?.contexts.map((context) => {
                            const isContextSelected =
                                selectedNode.type === "context" &&
                                selectedNode.contextId === context.id;
                            const isParentOfSelectedCase =
                                selectedNode.type === "case" &&
                                selectedNode.contextId === context.id;
                            const isActive =
                                isContextSelected || isParentOfSelectedCase;
                            const checkboxState =
                                contextSelectionState(context);

                            return (
                                <div
                                    key={context.id}
                                    className="rounded-lg border bg-white shadow-xs"
                                >
                                    <div className="flex items-center gap-2 px-3 py-2">
                                        <Checkbox
                                            checked={
                                                checkboxState as
                                                    | boolean
                                                    | "indeterminate"
                                            }
                                            onCheckedChange={(value) =>
                                                toggleContextChecked(
                                                    context,
                                                    value === true ||
                                                        value ===
                                                            "indeterminate",
                                                )
                                            }
                                        />
                                        <button
                                            type="button"
                                            className={cn(
                                                "flex flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                                isActive
                                                    ? "bg-primary/5 text-primary"
                                                    : "hover:bg-slate-100",
                                            )}
                                            onClick={() =>
                                                setSelectedNode({
                                                    type: "context",
                                                    contextId: context.id,
                                                })
                                            }
                                        >
                                            <span className="flex items-center gap-2 font-medium">
                                                <ChevronDown className="size-4" />
                                                {context.name}
                                            </span>
                                            <Badge variant="outline">
                                                {context.cases.length} cases
                                            </Badge>
                                        </button>
                                    </div>
                                    {context.cases.length > 0 ? (
                                        <div className="border-t bg-white">
                                            {context.cases.map((testCase) => {
                                                const caseSelected =
                                                    selectedNode.type ===
                                                        "case" &&
                                                    selectedNode.caseId ===
                                                        testCase.id;
                                                const status =
                                                    testCase.lastRunSummary
                                                        ?.status;
                                                return (
                                                    <div
                                                        key={testCase.id}
                                                        className="flex items-center gap-2 px-4 py-2"
                                                    >
                                                        <Checkbox
                                                            checked={checkedCaseIds.has(
                                                                testCase.id,
                                                            )}
                                                            onCheckedChange={(
                                                                value,
                                                            ) =>
                                                                toggleCaseChecked(
                                                                    testCase.id,
                                                                    value ===
                                                                        true,
                                                                )
                                                            }
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setSelectedNode(
                                                                    {
                                                                        type: "case",
                                                                        contextId:
                                                                            context.id,
                                                                        caseId: testCase.id,
                                                                    },
                                                                )
                                                            }
                                                            className={cn(
                                                                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                                                caseSelected
                                                                    ? "bg-primary/5 text-primary"
                                                                    : "hover:bg-slate-100",
                                                            )}
                                                        >
                                                            <span className="flex items-center gap-2">
                                                                <ChevronRight className="size-4 text-slate-400" />
                                                                {testCase.title}
                                                            </span>
                                                            {status ? (
                                                                <Badge
                                                                    variant={
                                                                        statusVariantMap[
                                                                            status
                                                                        ]
                                                                    }
                                                                >
                                                                    {
                                                                        statusLabelMap[
                                                                            status
                                                                        ]
                                                                    }
                                                                </Badge>
                                                            ) : null}
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </aside>

            <section className="flex-1 overflow-y-auto p-6 space-y-6">
                <RunControls
                    activeVersion={activeVersion}
                    runConfig={runConfig}
                    setRunConfig={setRunConfig}
                    isBusy={isBusy}
                    onRunVersion={async () => {
                        if (activeVersion) {
                            await runCases(
                                {
                                    kind: "version",
                                    versionId: activeVersion.id,
                                },
                                `version ${activeVersion.label}`,
                            );
                        }
                    }}
                />

                {selectedNode.type === "version" && activeVersion ? (
                    <VersionDetails
                        version={activeVersion}
                        isBusy={isBusy}
                        onSave={(updates) =>
                            handleUpdateVersion(activeVersion.id, updates)
                        }
                        onDelete={() => handleDeleteVersion(activeVersion.id)}
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
                ) : selectedNode.type === "context" && selectedContext ? (
                    <ContextDetails
                        context={selectedContext}
                        isBusy={isBusy}
                        onSave={(payload) =>
                            handleUpdateContext(selectedContext.id, payload)
                        }
                        onDelete={() => handleDeleteContext(selectedContext)}
                        onAddCase={() => handleAddCase(selectedContext.id)}
                        onRun={() =>
                            runCases(
                                {
                                    kind: "context",
                                    versionId: activeVersion!.id,
                                    contextId: selectedContext.id,
                                },
                                `context ${selectedContext.name}`,
                            )
                        }
                    />
                ) : selectedNode.type === "case" &&
                  selectedCase &&
                  selectedContext ? (
                    <CaseDetails
                        context={selectedContext}
                        testCase={selectedCase}
                        isBusy={isBusy}
                        onSave={(payload) =>
                            handleUpdateCase(
                                selectedContext.id,
                                selectedCase.id,
                                payload,
                            )
                        }
                        onDelete={() =>
                            handleDeleteCase(selectedContext.id, selectedCase)
                        }
                        onRun={() =>
                            runCases(
                                {
                                    kind: "case",
                                    versionId: activeVersion!.id,
                                    contextId: selectedContext.id,
                                    caseId: selectedCase.id,
                                },
                                `case ${selectedCase.title}`,
                            )
                        }
                    />
                ) : (
                    <EmptyState />
                )}
            </section>
        </div>
    );
}

function RunControls({
    activeVersion,
    runConfig,
    setRunConfig,
    onRunVersion,
    isBusy,
}: {
    activeVersion?: EvaluationVersion;
    runConfig: RunConfig;
    setRunConfig: Dispatch<SetStateAction<RunConfig>>;
    onRunVersion: () => Promise<void>;
    isBusy: boolean;
}) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Settings2 className="size-4" />
                        Run configuration
                    </CardTitle>
                    <CardDescription>
                        Configure batch size and concurrency before launching
                        runs.
                    </CardDescription>
                </div>
                <Button
                    size="sm"
                    disabled={isBusy || !activeVersion}
                    onClick={async () => {
                        await onRunVersion();
                    }}
                >
                    <Play className="mr-2 size-4" />
                    Run Version
                </Button>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                    <Label htmlFor="maxCasesPerRun">Cases per batch</Label>
                    <Input
                        id="maxCasesPerRun"
                        type="number"
                        min={1}
                        value={runConfig.maxCasesPerRun}
                        onChange={(event) =>
                            setRunConfig((prev) => ({
                                ...prev,
                                maxCasesPerRun: Math.max(
                                    1,
                                    Number.parseInt(
                                        event.target.value || "1",
                                        10,
                                    ),
                                ),
                            }))
                        }
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="concurrentRequests">
                        Concurrent requests
                    </Label>
                    <Input
                        id="concurrentRequests"
                        type="number"
                        min={1}
                        value={runConfig.concurrentRequests}
                        onChange={(event) =>
                            setRunConfig((prev) => ({
                                ...prev,
                                concurrentRequests: Math.max(
                                    1,
                                    Number.parseInt(
                                        event.target.value || "1",
                                        10,
                                    ),
                                ),
                            }))
                        }
                    />
                </div>
            </CardContent>
        </Card>
    );
}

function VersionDetails({
    version,
    onSave,
    onDelete,
    onRun,
    isBusy,
}: {
    version: EvaluationVersion;
    onSave: (updates: Partial<EvaluationVersion>) => Promise<void>;
    onDelete: () => Promise<void>;
    onRun: () => Promise<void>;
    isBusy: boolean;
}) {
    const [label, setLabel] = useState(version.label);
    const [notes, setNotes] = useState(version.notes ?? "");
    const [agentBaseUrl, setAgentBaseUrl] = useState(
        version.agentBaseUrl ?? "",
    );

    useEffect(() => {
        setLabel(version.label);
        setNotes(version.notes ?? "");
        setAgentBaseUrl(version.agentBaseUrl ?? "");
    }, [version]);

    const handleSave = async () => {
        await onSave({
            label,
            notes,
            agentBaseUrl,
        });
    };

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                    <CardTitle>Version overview</CardTitle>
                    <CardDescription>
                        Update metadata and review the contexts bundled in this
                        version.
                    </CardDescription>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={async () => {
                            await onRun();
                        }}
                    >
                        <Play className="mr-2 size-4" />
                        Run version
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        disabled={isBusy}
                        onClick={async () => {
                            await onDelete();
                        }}
                    >
                        <Trash2 className="mr-2 size-4" />
                        Delete
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="version-label">Label</Label>
                        <Input
                            id="version-label"
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="agent-url">Agent endpoint</Label>
                        <Input
                            id="agent-url"
                            value={agentBaseUrl}
                            placeholder="https://example.com/agent/stream"
                            onChange={(event) =>
                                setAgentBaseUrl(event.target.value)
                            }
                        />
                    </div>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="version-notes">Notes</Label>
                    <Textarea
                        id="version-notes"
                        rows={4}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                    />
                </div>
                <div className="flex justify-end">
                    <Button disabled={isBusy} onClick={handleSave}>
                        Save changes
                    </Button>
                </div>
                <Separator />
                <div className="space-y-3">
                    <h4 className="text-sm font-semibold text-slate-700">
                        Context summary
                    </h4>
                    <ul className="space-y-2">
                        {version.contexts.map((context) => (
                            <li
                                key={context.id}
                                className="flex items-center justify-between rounded-lg border bg-slate-50 px-4 py-2 text-sm"
                            >
                                <span className="font-medium">
                                    {context.name}
                                </span>
                                <span className="text-slate-500">
                                    {context.cases.length} cases
                                </span>
                            </li>
                        ))}
                        {version.contexts.length === 0 ? (
                            <li className="rounded-lg border border-dashed bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                                No contexts yet. Create one from the sidebar to
                                get started.
                            </li>
                        ) : null}
                    </ul>
                </div>
            </CardContent>
        </Card>
    );
}

function ContextDetails({
    context,
    onSave,
    onDelete,
    onAddCase,
    onRun,
    isBusy,
}: {
    context: EvaluationContext;
    onSave: (updates: Partial<EvaluationContext>) => Promise<void>;
    onDelete: () => Promise<void>;
    onAddCase: () => Promise<void>;
    onRun: () => Promise<void>;
    isBusy: boolean;
}) {
    const [name, setName] = useState(context.name);
    const [description, setDescription] = useState(context.description ?? "");
    const [paramsText, setParamsText] = useState(
        JSON.stringify(context.params ?? {}, null, 2),
    );
    const [headersText, setHeadersText] = useState(
        JSON.stringify(context.headers ?? {}, null, 2),
    );

    useEffect(() => {
        setName(context.name);
        setDescription(context.description ?? "");
        setParamsText(JSON.stringify(context.params ?? {}, null, 2));
        setHeadersText(JSON.stringify(context.headers ?? {}, null, 2));
    }, [context]);

    const handleSave = async () => {
        let parsedParams: Record<string, unknown> = {};
        let parsedHeaders: Record<string, string> = {};

        try {
            parsedParams =
                paramsText.trim().length > 0 ? JSON.parse(paramsText) : {};
        } catch (error) {
            toast.error("Params JSON is invalid.");
            return;
        }

        try {
            parsedHeaders =
                headersText.trim().length > 0 ? JSON.parse(headersText) : {};
        } catch (error) {
            toast.error("Headers JSON is invalid.");
            return;
        }

        await onSave({
            name,
            description,
            params: parsedParams,
            headers: parsedHeaders,
        });
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle>Context details</CardTitle>
                        <CardDescription>
                            Adjust metadata, payload params, and headers for
                            this context.
                        </CardDescription>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={async () => {
                                await onRun();
                            }}
                        >
                            <Play className="mr-2 size-4" />
                            Run context
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={isBusy}
                            onClick={async () => {
                                await onDelete();
                            }}
                        >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="context-name">Name</Label>
                            <Input
                                id="context-name"
                                value={name}
                                onChange={(event) =>
                                    setName(event.target.value)
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="context-description">
                                Description
                            </Label>
                            <Input
                                id="context-description"
                                value={description}
                                onChange={(event) =>
                                    setDescription(event.target.value)
                                }
                            />
                        </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="context-params">Params JSON</Label>
                            <Textarea
                                id="context-params"
                                rows={12}
                                value={paramsText}
                                onChange={(event) =>
                                    setParamsText(event.target.value)
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="context-headers">
                                Headers JSON
                            </Label>
                            <Textarea
                                id="context-headers"
                                rows={12}
                                value={headersText}
                                onChange={(event) =>
                                    setHeadersText(event.target.value)
                                }
                            />
                        </div>
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            disabled={isBusy}
                            onClick={async () => {
                                await onAddCase();
                            }}
                        >
                            <Plus className="mr-2 size-4" />
                            Add case
                        </Button>
                        <Button disabled={isBusy} onClick={handleSave}>
                            Save changes
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Cases in this context</CardTitle>
                    <CardDescription>
                        {context.cases.length} case
                        {context.cases.length === 1 ? "" : "s"} configured.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {context.cases.map((testCase) => (
                        <div
                            key={testCase.id}
                            className="rounded-lg border px-4 py-3 shadow-xs"
                        >
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <h4 className="font-medium">
                                        {testCase.title}
                                    </h4>
                                    {testCase.description ? (
                                        <p className="text-sm text-slate-500">
                                            {testCase.description}
                                        </p>
                                    ) : null}
                                </div>
                                {testCase.lastRunSummary ? (
                                    <Badge
                                        variant={
                                            statusVariantMap[
                                                testCase.lastRunSummary.status
                                            ]
                                        }
                                    >
                                        {
                                            statusLabelMap[
                                                testCase.lastRunSummary.status
                                            ]
                                        }
                                    </Badge>
                                ) : null}
                            </div>
                            <div className="mt-3 space-y-3">
                                <div>
                                    <h5 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                        User message
                                    </h5>
                                    <MessagePreview
                                        message={testCase.userMessage}
                                    />
                                </div>
                                {testCase.assistantMessage ? (
                                    <div>
                                        <h5 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                                            Assistant message
                                        </h5>
                                        <MessagePreview
                                            message={testCase.assistantMessage}
                                        />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    ))}
                    {context.cases.length === 0 ? (
                        <div className="rounded-lg border border-dashed bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                            No cases yet. Use “Add case” to create one.
                        </div>
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );
}

function CaseDetails({
    context,
    testCase,
    onSave,
    onDelete,
    onRun,
    isBusy,
}: {
    context: EvaluationContext;
    testCase: EvaluationCase;
    onSave: (updates: Partial<EvaluationCase>) => Promise<void>;
    onDelete: () => Promise<void>;
    onRun: () => Promise<void>;
    isBusy: boolean;
}) {
    const [title, setTitle] = useState(testCase.title);
    const [description, setDescription] = useState(testCase.description ?? "");
    const [userMessage, setUserMessage] = useState<
        EvaluationCase["userMessage"]
    >(testCase.userMessage);
    const [assistantMessage, setAssistantMessage] = useState<
        NonNullable<EvaluationCase["assistantMessage"]>
    >(testCase.assistantMessage ?? { role: "assistant", content: [] });

    useEffect(() => {
        setTitle(testCase.title);
        setDescription(testCase.description ?? "");
        setUserMessage(testCase.userMessage);
        setAssistantMessage(
            testCase.assistantMessage ?? { role: "assistant", content: [] },
        );
    }, [testCase]);

    const handleSave = async () => {
        const trimmedAssistant =
            assistantMessage.content.length > 0 ? assistantMessage : undefined;
        await onSave({
            title,
            description,
            userMessage,
            assistantMessage: trimmedAssistant,
        });
    };

    const status = testCase.lastRunSummary?.status;

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                        <CardTitle>Case details</CardTitle>
                        <CardDescription>
                            Configure the user prompt and metadata for this
                            case.
                        </CardDescription>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={async () => {
                                await onRun();
                            }}
                        >
                            <Play className="mr-2 size-4" />
                            Run case
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={isBusy}
                            onClick={async () => {
                                await onDelete();
                            }}
                        >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="case-title">Title</Label>
                            <Input
                                id="case-title"
                                value={title}
                                onChange={(event) =>
                                    setTitle(event.target.value)
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="case-description">
                                Description
                            </Label>
                            <Input
                                id="case-description"
                                value={description}
                                onChange={(event) =>
                                    setDescription(event.target.value)
                                }
                            />
                        </div>
                    </div>
                    <MessageBuilder
                        role="user"
                        message={userMessage}
                        onChange={(value) =>
                            setUserMessage(
                                value as EvaluationCase["userMessage"],
                            )
                        }
                    />
                    <Separator />
                    <MessageBuilder
                        role="assistant"
                        message={assistantMessage}
                        onChange={(value) =>
                            setAssistantMessage(
                                value as NonNullable<
                                    EvaluationCase["assistantMessage"]
                                >,
                            )
                        }
                    />
                    <div className="flex justify-end gap-2">
                        <Button disabled={isBusy} onClick={handleSave}>
                            Save changes
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Metadata</CardTitle>
                    <CardDescription>
                        Runtime information about previous executions of this
                        case.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <InfoRow
                        icon={<Database className="size-4 text-slate-500" />}
                        label="Context"
                        value={context.name}
                    />
                    {status ? (
                        <InfoRow
                            icon={
                                <Badge variant={statusVariantMap[status]}>
                                    {statusLabelMap[status]}
                                </Badge>
                            }
                            label="Last status"
                            value={statusLabelMap[status]}
                        />
                    ) : null}
                    {testCase.lastRunSummary?.durationMs ? (
                        <InfoRow
                            icon={<Clock className="size-4 text-slate-500" />}
                            label="Last duration"
                            value={`${testCase.lastRunSummary.durationMs} ms`}
                        />
                    ) : null}
                    {testCase.lastRunSummary?.completedAt ? (
                        <InfoRow
                            icon={<Clock className="size-4 text-slate-500" />}
                            label="Completed at"
                            value={formatDate(
                                testCase.lastRunSummary.completedAt,
                            )}
                        />
                    ) : null}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Message preview</CardTitle>
                    <CardDescription>
                        Structured payload sent to the downstream agent when
                        this case runs.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <PreviewSection
                        title="User message"
                        message={userMessage}
                    />
                    {userMessage.providerOptions ? (
                        <div>
                            <h4 className="mb-2 text-sm font-semibold text-slate-700">
                                Provider options
                            </h4>
                            <JsonViewer value={userMessage.providerOptions} />
                        </div>
                    ) : null}
                    <PreviewSection
                        title="Assistant message"
                        message={assistantMessage}
                    />
                    {assistantMessage.providerOptions ? (
                        <div>
                            <h4 className="mb-2 text-sm font-semibold text-slate-700">
                                Provider options
                            </h4>
                            <JsonViewer
                                value={assistantMessage.providerOptions}
                            />
                        </div>
                    ) : null}
                </CardContent>
            </Card>
        </div>
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

function PreviewSection({
    title,
    message,
}: {
    title: string;
    message:
        | EvaluationCase["userMessage"]
        | NonNullable<EvaluationCase["assistantMessage"]>;
}) {
    return (
        <div className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
            <MessagePreview message={message} />
        </div>
    );
}

function MessagePreview({
    message,
}: {
    message:
        | EvaluationCase["userMessage"]
        | EvaluationCase["assistantMessage"]
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
    return date.toLocaleString();
}
