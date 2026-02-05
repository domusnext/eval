import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
    evaluationCases,
    evaluationContexts,
    evaluationResults,
    evaluationVersions,
    type EvaluationResultStatus,
    getDb,
} from "@/db";
import type {
    CONTEXT_TREE_LIMITS,
    Environment,
    EvaluationCase,
    EvaluationContext,
    EvaluationTree,
    EvaluationVersion,
    Message,
    RunSelectionPayload,
    RunStatus,
    RunSummary,
} from "./models";
import type { AssistantModelMessage, UserModelMessage } from "./types";
import {
    canCreateChild,
    resolveContextConfig,
    type ContextNode,
} from "./context-resolver";
import { generateContextSummary } from "./ai-summarizer";
import { compressText, decompressText, isCompressed } from "./compression";

type EvaluationContextRow = typeof evaluationContexts.$inferSelect;
type EvaluationVersionInsert = typeof evaluationVersions.$inferInsert;
type EvaluationResultRow = typeof evaluationResults.$inferSelect;

const DEFAULT_JSON = "{}";
const CURRENT_TIMESTAMP = () => new Date();

// ==================== 工具函数 ====================

function toIso(value: unknown): string {
    if (!value) return new Date().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") return new Date(value).toISOString();
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString();
    }
    return new Date(String(value)).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
    if (!value) return fallback;
    try {
        if (typeof value === "string") {
            return JSON.parse(value) as T;
        }
        return value as T;
    } catch {
        return fallback;
    }
}

function stringifyJson(value: unknown): string {
    if (typeof value === "string") {
        try {
            JSON.parse(value);
            return value;
        } catch {
            // fall through to stringify
        }
    }
    return JSON.stringify(value ?? {});
}

function parseUserMessage(value: unknown): UserModelMessage {
    if (!value) {
        return {
            role: "user",
            content: "",
        };
    }

    if (typeof value === "object") {
        return value as UserModelMessage;
    }

    return parseJson<UserModelMessage>(value as string, {
        role: "user",
        content: "",
    });
}

function parseAssistantMessage(
    value: unknown,
): AssistantModelMessage | undefined {
    const parsed = typeof value === "object" && value !== null
        ? (value as AssistantModelMessage)
        : parseJson<AssistantModelMessage | null>(value as string | null, null);
    if (!parsed) return undefined;
    if (!Array.isArray(parsed.content)) {
        parsed.content = [];
    }
    return parsed;
}

function buildRunSummary(row: EvaluationResultRow): RunSummary {
    // 注意：不返回 responseContent 到 API 响应中
    // responseContent 太大且可能包含特殊字符导致 JSON 序列化错误
    // 前端可以通过单独的 API 获取完整的 response 内容

    return {
        status: row.status,
        durationMs: row.latencyMs ?? undefined,
        completedAt: row.completedAt ? toIso(row.completedAt) : undefined,
        // responseContent 不包含在这里 - 改为 undefined 避免 JSON 序列化错误
        responseContent: undefined,
        resultOverview: row.resultOverview ?? undefined,
        score: row.score ?? undefined,
    };
}

// ==================== Context 树形操作 ====================

/**
 * 将数据库行转换为 ContextNode
 */
function rowToContextNode(row: EvaluationContextRow): ContextNode {
    return {
        id: row.id,
        parentContextId: row.parentContextId ?? undefined,
        environment: parseJson<Environment>(row.environmentJson, {}),
        headers: parseJson<Record<string, string>>(row.headersJson, {}),
        recentMessages: parseJson<Message[]>(row.recentMessagesJson, []),
        contextSummary: row.contextSummary ?? undefined,
    };
}

/**
 * 解析单个 Context 的完整配置
 */
async function resolveContext(
    row: EvaluationContextRow,
    allContexts: Map<string, EvaluationContextRow>
): Promise<{
    resolvedEnvironment: Environment;
    resolvedHeaders: Record<string, string>;
    resolvedMessages: Message[];
}> {
    const getParent = (id: string) => {
        const parentRow = allContexts.get(id);
        return parentRow ? rowToContextNode(parentRow) : null;
    };

    const node = rowToContextNode(row);
    const resolved = resolveContextConfig(node, getParent);

    return {
        resolvedEnvironment: resolved.environment,
        resolvedHeaders: resolved.headers,
        resolvedMessages: resolved.messages,
    };
}

/**
 * 构建 Context 树（递归）
 */
async function buildContextTree(
    rootRow: EvaluationContextRow,
    allContexts: EvaluationContextRow[],
    allCases: EvaluationCase[],
    resultsByCase: Map<string, RunSummary>
): Promise<EvaluationContext> {
    // 创建 Context Map 用于快速查找
    const contextMap = new Map<string, EvaluationContextRow>();
    allContexts.forEach((ctx) => contextMap.set(ctx.id, ctx));

    // 解析完整配置
    const resolved = await resolveContext(rootRow, contextMap);

    // 查找子节点
    const children = allContexts.filter(
        (ctx) => ctx.parentContextId === rootRow.id
    );

    // 递归构建子树
    const childTrees = await Promise.all(
        children.map((child) =>
            buildContextTree(child, allContexts, allCases, resultsByCase)
        )
    );

    // 获取当前 Context 的 cases（所有 Context 都可以有 cases）
    const casesForContext = allCases
        .filter((c) => c.rootContextId === rootRow.id)
        .map((c) => ({
            ...c,
            lastRunSummary: resultsByCase.get(c.id),
        }));

    return {
        id: rootRow.id,
        name: rootRow.name,
        description: rootRow.description ?? undefined,
        parentContextId: rootRow.parentContextId ?? undefined,
        depth: rootRow.depth,
        childCount: rootRow.childCount,

        environment: parseJson<Environment>(rootRow.environmentJson, {}),
        headers: parseJson<Record<string, string>>(rootRow.headersJson, {}),
        recentMessages: parseJson<Message[]>(
            rootRow.recentMessagesJson,
            []
        ),
        contextSummary: rootRow.contextSummary ?? undefined,

        resolvedEnvironment: resolved.resolvedEnvironment,
        resolvedHeaders: resolved.resolvedHeaders,
        resolvedMessages: resolved.resolvedMessages,

        children: childTrees,
        cases: casesForContext,

        createdAt: toIso(rootRow.createdAt),
        updatedAt: toIso(rootRow.updatedAt),
    };
}

// ==================== 公共 API ====================

/**
 * 获取完整的 Evaluation Tree（森林结构）
 */
export async function fetchEvaluationTree(): Promise<EvaluationTree> {
    const db = await getDb();

    // 1. 获取所有 versions
    const versionRows = await db
        .select()
        .from(evaluationVersions)
        .orderBy(desc(evaluationVersions.createdAt));

    if (versionRows.length === 0) {
        return [];
    }

    // 2. 获取所有 contexts
    const allContexts = await db
        .select()
        .from(evaluationContexts)
        .orderBy(asc(evaluationContexts.depth), asc(evaluationContexts.createdAt));

    // 3. 获取所有 cases
    const caseRows = await db
        .select()
        .from(evaluationCases)
        .orderBy(asc(evaluationCases.orderIndex), asc(evaluationCases.createdAt));

    const allCases: EvaluationCase[] = caseRows.map((row) => ({
        id: row.id,
        rootContextId: row.rootContextId,
        title: row.title,
        description: row.description ?? undefined,
        userMessage: parseUserMessage(row.userMessageJson),
        evalRule: row.evalRule ?? undefined,
        metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
        orderIndex: row.orderIndex ?? undefined,
    }));

    // 4. 获取所有执行结果（分批查询，避免D1参数限制）
    const caseIds = caseRows.map((row) => row.id);
    const allResultRows: EvaluationResultRow[] = [];

    if (caseIds.length > 0) {
        const BATCH_SIZE = 50; // D1参数限制，每批最多50个
        for (let i = 0; i < caseIds.length; i += BATCH_SIZE) {
            const batchIds = caseIds.slice(i, i + BATCH_SIZE);
            const batchResults = await db
                .select()
                .from(evaluationResults)
                .where(inArray(evaluationResults.caseId, batchIds))
                .orderBy(desc(evaluationResults.startedAt), desc(evaluationResults.createdAt));
            allResultRows.push(...batchResults);
        }
    }

    // 按 versionId 分组结果
    const resultsByVersion = new Map<string, Map<string, RunSummary>>();
    for (const result of allResultRows) {
        if (!resultsByVersion.has(result.versionId)) {
            resultsByVersion.set(result.versionId, new Map());
        }
        const versionResults = resultsByVersion.get(result.versionId)!;
        // 每个 version 下，每个 case 只保留第一条（最新的，因为已按时间倒序排列）
        if (!versionResults.has(result.caseId)) {
            versionResults.set(result.caseId, buildRunSummary(result));
        }
    }

    // 5. 构建树结构
    const tree: EvaluationTree = await Promise.all(
        versionRows.map(async (versionRow) => {
            // 找到该 version 的根 contexts
            const rootContexts = allContexts.filter(
                (ctx) => ctx.parentContextId === null
            );

            // 获取该 version 的结果
            const resultsByCase = resultsByVersion.get(versionRow.id) || new Map();

            // 为每个根构建子树
            const rootTrees = await Promise.all(
                rootContexts.map((root) =>
                    buildContextTree(root, allContexts, allCases, resultsByCase)
                )
            );

            return {
                id: versionRow.id,
                label: versionRow.label,
                notes: versionRow.notes ?? undefined,
                agentBaseUrl: versionRow.agentBaseUrl ?? undefined,
                createdAt: toIso(versionRow.createdAt),
                updatedAt: toIso(versionRow.updatedAt),
                rootContexts: rootTrees,
            } satisfies EvaluationVersion;
        })
    );

    return tree;
}

// ==================== Version 操作 ====================

export async function createEvaluationVersion(input?: {
    label?: string;
    notes?: string;
    agentBaseUrl?: string;
}): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();

    // 如果没有提供 label，生成默认命名：V{YYYY/MM/DD}(x)
    let label = input?.label;
    if (!label) {
        const now = new Date();
        const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        const baseLabel = `V${dateStr}`;

        // 查询当天已有的 versions，找出最大的序号
        const existingVersions = await db
            .select()
            .from(evaluationVersions)
            .where(eq(evaluationVersions.label, baseLabel))
            .limit(1);

        if (existingVersions.length === 0) {
            // 第一个，不带序号
            label = baseLabel;
        } else {
            // 查询所有以 baseLabel 开头的 versions，找出最大序号
            const allVersions = await db
                .select()
                .from(evaluationVersions);

            const pattern = new RegExp(`^${baseLabel.replace(/\//g, '\\/')}(?:\\((\\d+)\\))?$`);
            let maxNumber = 1; // 第一个已存在，所以从 1 开始

            for (const version of allVersions) {
                const match = version.label.match(pattern);
                if (match) {
                    const num = match[1] ? parseInt(match[1], 10) : 1;
                    maxNumber = Math.max(maxNumber, num);
                }
            }

            label = `${baseLabel}(${maxNumber + 1})`;
        }
    }

    const values: EvaluationVersionInsert = {
        id,
        label,
        notes: input?.notes ?? null,
        agentBaseUrl: input?.agentBaseUrl ?? null,
        createdBy: null,
    };
    await db.insert(evaluationVersions).values(values);
    return id;
}

export async function updateEvaluationVersion(
    id: string,
    updates: Partial<
        Pick<EvaluationVersion, "label" | "notes" | "agentBaseUrl">
    >
): Promise<void> {
    const db = await getDb();
    const payload: Record<string, unknown> = {
        updatedAt: CURRENT_TIMESTAMP(),
    };

    if (updates.label !== undefined) payload.label = updates.label;
    if (updates.notes !== undefined) payload.notes = updates.notes ?? null;
    if (updates.agentBaseUrl !== undefined) {
        payload.agentBaseUrl = updates.agentBaseUrl ?? null;
    }

    await db
        .update(evaluationVersions)
        .set(payload)
        .where(eq(evaluationVersions.id, id));
}

export async function deleteEvaluationVersion(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(evaluationVersions).where(eq(evaluationVersions.id, id));
}

export async function duplicateEvaluationVersion(id: string): Promise<string> {
    const db = await getDb();
    const [original] = await db
        .select()
        .from(evaluationVersions)
        .where(eq(evaluationVersions.id, id))
        .limit(1);

    if (!original) {
        throw new Error(`Version ${id} not found`);
    }

    const newId = crypto.randomUUID();
    await db.insert(evaluationVersions).values({
        id: newId,
        label: `${original.label} (Copy)`,
        notes: original.notes,
        agentBaseUrl: original.agentBaseUrl,
        createdBy: original.createdBy,
    });

    return newId;
}

// ==================== Context 操作 ====================

/**
 * 创建根 Context
 */
export async function createEvaluationContext(input: {
    name?: string;
    description?: string;
    environment?: Environment;
    headers?: Record<string, string>;
    contextSummary?: string;
}): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();

    await db.insert(evaluationContexts).values({
        id,
        name: input.name ?? "New Context",
        description: input.description ?? null,
        parentContextId: null, // 根节点
        depth: 0,
        childCount: 0,
        environmentJson: stringifyJson(input.environment ?? {}),
        headersJson: stringifyJson(input.headers ?? {}),
        recentMessagesJson: "[]",
        contextSummary: input.contextSummary ?? null,
        createdAt: CURRENT_TIMESTAMP(),
        updatedAt: CURRENT_TIMESTAMP(),
    });

    return id;
}

/**
 * 创建子 Context
 */
export async function createChildContext(
    parentId: string,
    input: {
        name?: string;
        description?: string;
        environment?: Environment;
        headers?: Record<string, string>;
        recentMessages?: Message[];
    }
): Promise<string> {
    const db = await getDb();

    // 1. 获取父节点
    const [parent] = await db
        .select()
        .from(evaluationContexts)
        .where(eq(evaluationContexts.id, parentId))
        .limit(1);

    if (!parent) {
        throw new Error(`Parent context ${parentId} not found`);
    }

    // 2. 验证是否可以创建子节点
    const validation = canCreateChild(
        { depth: parent.depth, childCount: parent.childCount },
        10, // MAX_DEPTH
        50  // MAX_CHILDREN
    );

    if (!validation.canCreate) {
        throw new Error(validation.reason);
    }

    // 3. 创建子节点
    // 获取所有 contexts 用于解析父节点的完整配置
    const allContexts = await db.select().from(evaluationContexts);
    const contextMap = new Map<string, EvaluationContextRow>();
    allContexts.forEach((ctx) => contextMap.set(ctx.id, ctx));

    // 解析父节点的完整配置（包括从祖先继承的）
    const parentResolved = await resolveContext(parent, contextMap);

    // 从父节点的 resolved 配置完整拷贝（深拷贝）
    const parentEnvironment = JSON.parse(JSON.stringify(parentResolved.resolvedEnvironment));
    const parentHeaders = JSON.parse(JSON.stringify(parentResolved.resolvedHeaders));

    // 如果 input 提供了 environment 或 headers，则覆盖父节点的配置
    const childEnvironment = input.environment !== undefined
        ? { ...parentEnvironment, ...input.environment }
        : parentEnvironment;
    const childHeaders = input.headers !== undefined
        ? { ...parentHeaders, ...input.headers }
        : parentHeaders;

    // 计算完整的 resolvedMessages（父节点的 + 新增的）
    const fullMessages = [
        ...parentResolved.resolvedMessages,
        ...(input.recentMessages ?? [])
    ];

    // 生成 AI 总结（异步但不阻塞）
    let contextSummary: string | null = null;
    if (input.recentMessages && input.recentMessages.length > 0) {
        console.log(`[Repository] Generating AI summary for new context with ${fullMessages.length} total messages...`);
        try {
            contextSummary = await generateContextSummary(fullMessages);
            console.log(`[Repository] AI summary generated successfully: ${contextSummary ? contextSummary.substring(0, 50) + "..." : "(empty)"}`);
        } catch (error) {
            console.error("[Repository] Failed to generate context summary:", error);
            // 继续创建 context，即使总结失败
        }
    }

    const childId = crypto.randomUUID();
    await db.insert(evaluationContexts).values({
        id: childId,
        name: input.name ?? `${parent.name} (Child)`,
        description: input.description ?? null,
        parentContextId: parentId,
        depth: parent.depth + 1,
        childCount: 0,
        environmentJson: stringifyJson(childEnvironment),
        headersJson: stringifyJson(childHeaders),
        recentMessagesJson: stringifyJson(input.recentMessages ?? []),
        contextSummary: contextSummary,
        createdAt: CURRENT_TIMESTAMP(),
        updatedAt: CURRENT_TIMESTAMP(),
    });

    // 4. 更新父节点的 childCount
    await db
        .update(evaluationContexts)
        .set({ childCount: parent.childCount + 1 })
        .where(eq(evaluationContexts.id, parentId));

    return childId;
}

export async function updateEvaluationContext(
    id: string,
    updates: Partial<{
        name: string;
        description: string;
        environment: Environment;
        headers: Record<string, string>;
        contextSummary: string;
    }>
): Promise<void> {
    const db = await getDb();
    const payload: Record<string, unknown> = {
        updatedAt: CURRENT_TIMESTAMP(),
    };

    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.description !== undefined) {
        payload.description = updates.description ?? null;
    }
    if (updates.environment !== undefined) {
        payload.environmentJson = stringifyJson(updates.environment);
    }
    if (updates.headers !== undefined) {
        payload.headersJson = stringifyJson(updates.headers);
    }
    if (updates.contextSummary !== undefined) {
        payload.contextSummary = updates.contextSummary ?? null;
    }

    await db
        .update(evaluationContexts)
        .set(payload)
        .where(eq(evaluationContexts.id, id));
}

export async function deleteEvaluationContext(id: string): Promise<void> {
    const db = await getDb();

    // 获取要删除的节点
    const [context] = await db
        .select()
        .from(evaluationContexts)
        .where(eq(evaluationContexts.id, id))
        .limit(1);

    if (!context) {
        return;
    }

    // 删除节点（级联删除子节点）
    await db.delete(evaluationContexts).where(eq(evaluationContexts.id, id));

    // 如果有父节点，更新父节点的 childCount
    if (context.parentContextId) {
        const [parent] = await db
            .select()
            .from(evaluationContexts)
            .where(eq(evaluationContexts.id, context.parentContextId))
            .limit(1);

        if (parent) {
            await db
                .update(evaluationContexts)
                .set({ childCount: Math.max(0, parent.childCount - 1) })
                .where(eq(evaluationContexts.id, context.parentContextId));
        }
    }
}

// ==================== Case 操作 ====================

export async function createEvaluationCase(input: {
    rootContextId: string;
    title?: string;
    description?: string;
    userMessage?: UserModelMessage;
    evalRule?: string;
    metadata?: Record<string, unknown>;
}): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();

    const userMessage: UserModelMessage = input.userMessage ?? {
        role: "user",
        content: "",
    };

    const now = Date.now();

    await db.insert(evaluationCases).values({
        id,
        rootContextId: input.rootContextId,
        title: input.title ?? "New Case",
        description: input.description ?? null,
        userMessageJson: stringifyJson(userMessage),
        evalRule: input.evalRule ?? null,
        metadataJson: stringifyJson(input.metadata ?? {}),
        orderIndex: now,
        createdAt: new Date(now),
        updatedAt: new Date(now),
    });

    return id;
}

export async function updateEvaluationCase(
    id: string,
    updates: Partial<
        Pick<
            EvaluationCase,
            "title" | "description" | "userMessage" | "evalRule" | "metadata"
        >
    >,
): Promise<void> {
    const db = await getDb();
    const payload: Record<string, unknown> = {
        updatedAt: CURRENT_TIMESTAMP(),
    };

    if (updates.title !== undefined) payload.title = updates.title;
    if (updates.description !== undefined) {
        payload.description = updates.description ?? null;
    }
    if (updates.userMessage !== undefined) {
        payload.userMessageJson = stringifyJson(updates.userMessage);
    }
    if (updates.evalRule !== undefined) {
        payload.evalRule = updates.evalRule ?? null;
    }
    if (updates.metadata !== undefined) {
        payload.metadataJson = stringifyJson(updates.metadata ?? {});
    }

    await db
        .update(evaluationCases)
        .set(payload)
        .where(eq(evaluationCases.id, id));
}

export async function deleteEvaluationCase(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(evaluationCases).where(eq(evaluationCases.id, id));
}

// ==================== 执行相关 ====================

/**
 * 保存单个 case 的运行结果（前端运行后调用）
 * 如果该 version 下已有该 case 的结果，则覆盖
 */
export async function saveEvaluationResult(input: {
    versionId: string;
    contextId: string;
    caseId: string;
    status: EvaluationResultStatus;
    responseContent: string;
    resultOverview?: string;
    score?: number;
    latencyMs?: number;
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
}): Promise<void> {
    const db = await getDb();

    // 压缩 responseContent
    let compressedResponse: string;
    const MAX_SIZE_BYTES = 60000; // 60KB 限制（留出安全边际）

    try {
        compressedResponse = compressText(input.responseContent);

        // 检查压缩后的大小
        if (compressedResponse.length > MAX_SIZE_BYTES) {
            const sizeKB = Math.round(compressedResponse.length / 1024);
            console.error(
                `[SaveResult] Compressed response still too large: ${sizeKB}KB (limit: ${Math.round(MAX_SIZE_BYTES / 1024)}KB)`,
            );
            throw new Error(
                `Compressed response exceeds size limit: ${sizeKB}KB`,
            );
        }
    } catch (error) {
        console.error("[SaveResult] Compression failed:", error);
        throw error; // 重新抛出错误，阻止保存
    }

    // 1. 删除该 version 下该 case 的旧结果
    await db
        .delete(evaluationResults)
        .where(
            and(
                eq(evaluationResults.versionId, input.versionId),
                eq(evaluationResults.caseId, input.caseId),
            ),
        );

    // 2. 插入新结果（使用压缩后的数据）
    const now = new Date();
    await db.insert(evaluationResults).values({
        id: crypto.randomUUID(),
        versionId: input.versionId,
        contextId: input.contextId,
        caseId: input.caseId,
        runId: crypto.randomUUID(), // 单个 case 运行，生成独立的 runId
        status: input.status,
        requestPayload: "{}",  // 前端已经有 case 的 userMessage，这里不重复存储
        responseJson: compressedResponse, // 存储压缩后的 base64 字符串
        resultOverview: input.resultOverview ?? null,
        score: input.score ?? null,
        latencyMs: input.latencyMs ?? null,
        startedAt: input.startedAt ?? now,
        completedAt: input.completedAt ?? now,
        error: input.error ?? null,
        createdAt: now,
    });
}

/**
 * 获取评估结果（包含完整的 responseContent）
 * 用于按需加载大型响应数据
 */
export async function getEvaluationResult(input: {
    versionId: string;
    caseId: string;
}): Promise<{
    responseContent: string;
    status: EvaluationResultStatus;
    resultOverview?: string;
    score?: number;
    latencyMs?: number;
    completedAt?: string;
} | null> {
    const db = await getDb();

    // 查询该 version 下该 case 的最新结果
    const results = await db
        .select()
        .from(evaluationResults)
        .where(
            and(
                eq(evaluationResults.versionId, input.versionId),
                eq(evaluationResults.caseId, input.caseId),
            ),
        )
        .orderBy(desc(evaluationResults.startedAt), desc(evaluationResults.createdAt))
        .limit(1);

    if (results.length === 0) {
        return null;
    }

    const result = results[0];

    // 解压 responseContent
    let responseContent = result.responseJson || "";
    if (responseContent && isCompressed(responseContent)) {
        try {
            responseContent = decompressText(responseContent);
        } catch (error) {
            console.error("[GetResult] Failed to decompress responseContent:", error);
            // 如果解压失败，返回原始数据
        }
    }

    return {
        responseContent,
        status: result.status,
        resultOverview: result.resultOverview ?? undefined,
        score: result.score ?? undefined,
        latencyMs: result.latencyMs ?? undefined,
        completedAt: result.completedAt ? toIso(result.completedAt) : undefined,
    };
}

/**
 * 递归收集 context 及其所有子孙 context 的 ID
 */
function collectContextIdsRecursively(
    contextId: string,
    allContexts: EvaluationContextRow[]
): string[] {
    const result = [contextId];
    const children = allContexts.filter(ctx => ctx.parentContextId === contextId);

    for (const child of children) {
        result.push(...collectContextIdsRecursively(child.id, allContexts));
    }

    return result;
}

export async function queueEvaluationRun(
    payload: RunSelectionPayload,
): Promise<{ runId: string; caseCount: number }> {
    const db = await getDb();
    const runId = crypto.randomUUID();

    // 获取所有 contexts（用于查找 cases）
    const contexts = await db.select().from(evaluationContexts);

    if (contexts.length === 0) {
        return { runId, caseCount: 0 };
    }

    // 如果指定了 contextIds，递归收集所有子 context
    let allContextIds: string[];
    if (payload.contextIds?.length) {
        const expandedIds = new Set<string>();
        for (const contextId of payload.contextIds) {
            const idsWithChildren = collectContextIdsRecursively(contextId, contexts);
            idsWithChildren.forEach(id => expandedIds.add(id));
        }
        allContextIds = Array.from(expandedIds);
    } else {
        // 没有指定 contextIds，使用所有 contexts
        allContextIds = contexts.map((context) => context.id);
    }

    // 分批查询cases（避免D1参数限制）
    let cases: typeof evaluationCases.$inferSelect[] = [];
    if (allContextIds.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < allContextIds.length; i += BATCH_SIZE) {
            const batchIds = allContextIds.slice(i, i + BATCH_SIZE);
            const batchCases = await db
                .select()
                .from(evaluationCases)
                .where(inArray(evaluationCases.rootContextId, batchIds));
            cases.push(...batchCases);
        }
    }

    let caseList = cases;
    if (payload.caseIds?.length) {
        const requestedIds = new Set(payload.caseIds);
        caseList = cases.filter((item) => requestedIds.has(item.id));
    }

    if (payload.maxCasesPerRun && payload.maxCasesPerRun > 0) {
        caseList = caseList.slice(0, payload.maxCasesPerRun);
    }

    if (caseList.length === 0) {
        return { runId, caseCount: 0 };
    }

    const contextsMap = new Map<string, EvaluationContextRow>();
    for (const context of contexts) {
        contextsMap.set(context.id, context);
    }

    const caseIdsToOverride = caseList.map((item) => item.id);

    // 分批删除旧结果（避免D1参数限制）
    if (caseIdsToOverride.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < caseIdsToOverride.length; i += BATCH_SIZE) {
            const batchIds = caseIdsToOverride.slice(i, i + BATCH_SIZE);
            await db
                .delete(evaluationResults)
                .where(
                    and(
                        eq(evaluationResults.versionId, payload.versionId),
                        inArray(evaluationResults.caseId, batchIds),
                    ),
                );
        }
    }

    const resultValues = caseList.map((caseRow) => {
        const context = contextsMap.get(caseRow.rootContextId);
        const headers = context
            ? parseJson<Record<string, string>>(context.headersJson, {})
            : {};

        const requestPayload = {
            headers,
            userMessage: parseUserMessage(caseRow.userMessageJson),
        };

        const simulatedResponse = {
            role: "assistant",
            content: [],
        };

        const latency = 500 + Math.floor(Math.random() * 1200);
        const startedAt = new Date();
        const completedAt = new Date(startedAt.getTime() + latency);

        return {
            id: crypto.randomUUID(),
            versionId: payload.versionId,
            contextId: caseRow.rootContextId,
            caseId: caseRow.id,
            runId,
            status: "succeeded" as EvaluationResultStatus,
            requestPayload: stringifyJson(requestPayload),
            responseJson: stringifyJson({
                assistantMessage: simulatedResponse,
            }),
            resultOverview: null,
            score: null,
            latencyMs: latency,
            startedAt,
            completedAt,
            error: null,
            createdAt: new Date(),
        };
    });

    await db.insert(evaluationResults).values(resultValues);

    return {
        runId,
        caseCount: resultValues.length,
    };
}

/**
 * 从 Case 运行结果创建子 Context
 * 替代原来的 createContextWithMessages
 */
export async function createChildContextFromCaseResult(
    parentContextId: string,
    newMessages: Message[],
    caseTitle?: string
): Promise<string> {
    const timestamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
    const nameSuffix = caseTitle ? `[${caseTitle}] ${timestamp}` : timestamp;

    return await createChildContext(parentContextId, {
        name: nameSuffix,
        recentMessages: newMessages,
    });
}
