import type { AssistantModelMessage, UserModelMessage } from "./types";

export type RunStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "timeout";

export type RunSummary = {
    status: RunStatus;
    durationMs?: number;
    completedAt?: string;
};

export type EvaluationCase = {
    id: string;
    title: string;
    description?: string;
    userMessage: UserModelMessage;
    assistantMessage?: AssistantModelMessage;
    metadata?: Record<string, unknown>;
    orderIndex?: number;
    lastRunSummary?: RunSummary;
};

export type EvaluationContext = {
    id: string;
    name: string;
    description?: string;
    params: Record<string, unknown>;
    headers: Record<string, string>;
    orderIndex?: number;
    cases: EvaluationCase[];
};

export type EvaluationVersion = {
    id: string;
    label: string;
    notes?: string;
    agentBaseUrl?: string;
    createdAt: string;
    updatedAt: string;
    contexts: EvaluationContext[];
};

export type EvaluationTree = EvaluationVersion[];

export type RunSelectionPayload = {
    versionId: string;
    contextIds?: string[];
    caseIds?: string[];
    maxCasesPerRun?: number;
    concurrentRequests?: number;
};
