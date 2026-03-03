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
    responseContent?: string;
    resultOverview?: string;
    score?: number;
};

/**
 * Environment 配置类型
 * 包含 family_info, user_brief, chat_info 三个对象
 */
export type Environment = {
    family_info?: Record<string, unknown>;
    user_brief?: Record<string, unknown>;
    chat_info?: Record<string, unknown>;
};

/**
 * 消息类型（与 response-converter 中的格式对应）
 */
export type Message = {
    role: "user" | "assistant" | "tool";
    content: unknown[]; // 灵活的 content 类型
};

export type EvaluationCase = {
    id: string;
    rootContextId: string; // 修改：指向根 Context
    title: string;
    description?: string;
    userMessage: UserModelMessage;
    evalRule?: string;
    metadata?: Record<string, unknown>;
    orderIndex?: number;
    // 从 evaluationResults 表查询的最新运行结果（按 versionId 区分）
    lastRunSummary?: RunSummary;
};

/**
 * Context 树节点类型
 */
export type EvaluationContext = {
    id: string;
    name: string;
    description?: string;

    // 树状结构
    parentContextId?: string;
    depth: number;
    childCount: number;

    // 当前节点的配置（增量存储）
    environment?: Environment;
    headers?: Record<string, string>;
    recentMessages?: Message[]; // 只包含当前节点新增的消息
    contextSummary?: string; // Context 摘要描述

    // 解析后的完整配置（合并父节点）
    resolvedEnvironment: Environment;
    resolvedHeaders: Record<string, string>;
    resolvedMessages: Message[]; // 从根到当前的所有消息

    // 子节点
    children: EvaluationContext[];

    // Cases（所有 Context 都可以有 cases）
    cases: EvaluationCase[];

    createdAt: string;
    updatedAt: string;
};

export type VersionMode = "agent" | "voice-agent";

export type EvaluationVersion = {
    id: string;
    label: string;
    notes?: string;
    agentBaseUrl?: string;
    mode: VersionMode;
    createdAt: string;
    updatedAt: string;
    rootContexts: EvaluationContext[]; // 修改：多个根节点
};

export type EvaluationTree = EvaluationVersion[];

export type RunSelectionPayload = {
    versionId: string;
    contextIds?: string[];
    caseIds?: string[];
    maxCasesPerRun?: number;
    concurrentRequests?: number;
};

/**
 * 树的深度和子节点数量限制
 */
export const CONTEXT_TREE_LIMITS = {
    MAX_DEPTH: 10,
    MAX_CHILDREN: 50,
} as const;
