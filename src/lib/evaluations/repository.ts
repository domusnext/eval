import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
    evaluationCases,
    evaluationContexts,
    evaluationResults,
    evaluationVersions,
    type EvaluationResultStatus,
    getDb,
} from "@/db";
import type {
    EvaluationCase,
    EvaluationContext,
    EvaluationTree,
    EvaluationVersion,
    RunSelectionPayload,
    RunSummary,
} from "./models";
import type { AssistantModelMessage, UserModelMessage } from "./types";

type EvaluationContextRow = typeof evaluationContexts.$inferSelect;
type EvaluationVersionInsert = typeof evaluationVersions.$inferInsert;
type EvaluationResultRow = typeof evaluationResults.$inferSelect;

const DEFAULT_JSON = "{}";

const CURRENT_TIMESTAMP = () => Date.now();

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
    return {
        status: row.status,
        durationMs: row.latencyMs ?? undefined,
        completedAt: row.completedAt ? toIso(row.completedAt) : undefined,
    };
}

export async function fetchEvaluationTree(): Promise<EvaluationTree> {
    const db = await getDb();

    const versionRows = await db
        .select()
        .from(evaluationVersions)
        .orderBy(desc(evaluationVersions.createdAt));

    if (versionRows.length === 0) {
        return [];
    }

    const contextRows = await db
        .select()
        .from(evaluationContexts)
        .orderBy(
            asc(evaluationContexts.orderIndex),
            asc(evaluationContexts.createdAt),
        );

    const contextIds = contextRows.map((row) => row.id);

    const caseRows = contextIds.length
        ? await db
              .select()
              .from(evaluationCases)
              .where(inArray(evaluationCases.contextId, contextIds))
              .orderBy(
                  asc(evaluationCases.orderIndex),
                  asc(evaluationCases.createdAt),
              )
        : [];

    const baseContexts = contextRows.map((contextRow) => ({
        id: contextRow.id,
        name: contextRow.name,
        description: contextRow.description ?? undefined,
        params: parseJson<Record<string, unknown>>(contextRow.paramsJson, {}),
        headers: parseJson<Record<string, string>>(contextRow.headersJson, {}),
        orderIndex: contextRow.orderIndex ?? undefined,
        cases: [] as EvaluationCase[],
    }));

    const baseContextsById = new Map<string, (typeof baseContexts)[number]>();
    baseContexts.forEach((context) =>
        baseContextsById.set(context.id, context),
    );

    for (const caseRow of caseRows) {
        const owner = baseContextsById.get(caseRow.contextId);
        if (!owner) continue;
        owner.cases.push({
            id: caseRow.id,
            title: caseRow.title,
            description: caseRow.description ?? undefined,
            userMessage: parseUserMessage(caseRow.userMessageJson),
            assistantMessage: parseAssistantMessage(
                caseRow.assistantMessageJson,
            ),
            metadata: parseJson<Record<string, unknown>>(
                caseRow.metadataJson,
                {},
            ),
            orderIndex: caseRow.orderIndex ?? undefined,
        });
    }

    const versionIds = versionRows.map((row) => row.id);
    const caseIds = caseRows.map((row) => row.id);

    const resultRows =
        versionIds.length && caseIds.length
            ? await db
                  .select()
                  .from(evaluationResults)
                  .where(
                      and(
                          inArray(evaluationResults.versionId, versionIds),
                          inArray(evaluationResults.caseId, caseIds),
                      ),
                  )
                  .orderBy(
                      desc(evaluationResults.startedAt),
                      desc(evaluationResults.createdAt),
                  )
            : [];

    const resultsByVersion = new Map<string, Map<string, RunSummary>>();
    for (const result of resultRows) {
        let caseMap = resultsByVersion.get(result.versionId);
        if (!caseMap) {
            caseMap = new Map<string, RunSummary>();
            resultsByVersion.set(result.versionId, caseMap);
        }
        if (!caseMap.has(result.caseId)) {
            caseMap.set(result.caseId, buildRunSummary(result));
        }
    }

    return versionRows.map((versionRow) => {
        const caseMap = resultsByVersion.get(versionRow.id) ?? new Map();
        const contexts = baseContexts.map((context) => ({
            id: context.id,
            name: context.name,
            description: context.description,
            params: context.params,
            headers: context.headers,
            orderIndex: context.orderIndex,
            cases: context.cases.map((testCase) => ({
                ...testCase,
                lastRunSummary: caseMap.get(testCase.id),
            })),
        }));

        return {
            id: versionRow.id,
            label: versionRow.label,
            notes: versionRow.notes ?? undefined,
            agentBaseUrl: versionRow.agentBaseUrl ?? undefined,
            createdAt: toIso(versionRow.createdAt),
            updatedAt: toIso(versionRow.updatedAt),
            contexts,
        } satisfies EvaluationVersion;
    });
}

export async function createEvaluationVersion(input?: {
    label?: string;
    notes?: string;
    agentBaseUrl?: string;
}): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();
    const values: EvaluationVersionInsert = {
        id,
        label: input?.label ?? "New Version",
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
    >,
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
    const versionRow = await db
        .select()
        .from(evaluationVersions)
        .where(eq(evaluationVersions.id, id))
        .limit(1);

    if (!versionRow.length) {
        throw new Error("Version not found");
    }

    return createEvaluationVersion({
        label: `${versionRow[0].label} (copy)`,
        notes: versionRow[0].notes ?? undefined,
        agentBaseUrl: versionRow[0].agentBaseUrl ?? undefined,
    });
}

export async function createEvaluationContext(input: {
    name?: string;
    description?: string;
}): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();
    await db.insert(evaluationContexts).values({
        id,
        name: input.name ?? "New Context",
        description: input.description ?? null,
        paramsJson: DEFAULT_JSON,
        headersJson: DEFAULT_JSON,
        orderIndex: Date.now(),
    });
    return id;
}

export async function updateEvaluationContext(
    id: string,
    updates: Partial<
        Pick<EvaluationContext, "name" | "description" | "params" | "headers">
    >,
): Promise<void> {
    const db = await getDb();
    const payload: Record<string, unknown> = {
        updatedAt: CURRENT_TIMESTAMP(),
    };

    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.description !== undefined) {
        payload.description = updates.description ?? null;
    }
    if (updates.params !== undefined) {
        payload.paramsJson = stringifyJson(updates.params);
    }
    if (updates.headers !== undefined) {
        payload.headersJson = stringifyJson(updates.headers);
    }

    await db
        .update(evaluationContexts)
        .set(payload)
        .where(eq(evaluationContexts.id, id));
}

export async function deleteEvaluationContext(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(evaluationContexts).where(eq(evaluationContexts.id, id));
}

export async function createEvaluationCase(input: {
    contextId: string;
    title?: string;
    description?: string;
}): Promise<string> {
    const db = await getDb();
    const id = crypto.randomUUID();
    await db.insert(evaluationCases).values({
        id,
        contextId: input.contextId,
        title: input.title ?? "New Case",
        description: input.description ?? null,
        userMessageJson: stringifyJson({
            role: "user",
            content: "",
        }),
        assistantMessageJson: null,
        metadataJson: DEFAULT_JSON,
        orderIndex: Date.now(),
    });
    return id;
}

export async function updateEvaluationCase(
    id: string,
    updates: Partial<
        Pick<
            EvaluationCase,
            | "title"
            | "description"
            | "userMessage"
            | "assistantMessage"
            | "metadata"
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
    if (updates.assistantMessage !== undefined) {
        payload.assistantMessageJson = updates.assistantMessage
            ? stringifyJson(updates.assistantMessage)
            : null;
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

export async function queueEvaluationRun(
    payload: RunSelectionPayload,
): Promise<{ runId: string; caseCount: number }> {
    const db = await getDb();
    const runId = crypto.randomUUID();
    const contexts = await db.select().from(evaluationContexts);

    if (contexts.length === 0) {
        return { runId, caseCount: 0 };
    }

    const selectedContextIds = payload.contextIds?.length
        ? new Set(payload.contextIds)
        : new Set(contexts.map((context) => context.id));

    const allContextIds = contexts
        .filter((context) => selectedContextIds.has(context.id))
        .map((context) => context.id);

    const cases = await db
        .select()
        .from(evaluationCases)
        .where(inArray(evaluationCases.contextId, allContextIds));

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

    if (caseIdsToOverride.length) {
        await db
            .delete(evaluationResults)
            .where(
                and(
                    eq(evaluationResults.versionId, payload.versionId),
                    inArray(evaluationResults.caseId, caseIdsToOverride),
                ),
            );
    }

    const resultValues = caseList.map((caseRow) => {
        const context = contextsMap.get(caseRow.contextId);
        const params = context
            ? parseJson<Record<string, unknown>>(context.paramsJson, {})
            : {};
        const headers = context
            ? parseJson<Record<string, string>>(context.headersJson, {})
            : {};

        const requestPayload = {
            params,
            headers,
            userMessage: parseUserMessage(caseRow.userMessageJson),
        };

        const assistantMessage = parseAssistantMessage(
            caseRow.assistantMessageJson,
        );

        const simulatedResponse = assistantMessage
            ? assistantMessage
            : {
                  role: "assistant",
                  content: [],
              };

        const latency = 500 + Math.floor(Math.random() * 1200);
        const startedAt = new Date();
        const completedAt = new Date(startedAt.getTime() + latency);

        return {
            id: crypto.randomUUID(),
            versionId: payload.versionId,
            contextId: caseRow.contextId,
            caseId: caseRow.id,
            runId,
            status: "succeeded" as EvaluationResultStatus,
            requestPayload: stringifyJson(requestPayload),
            responseJson: stringifyJson({
                assistantMessage: simulatedResponse,
            }),
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
