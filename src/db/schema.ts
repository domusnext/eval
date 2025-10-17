import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
    AssistantModelMessage,
    UserModelMessage,
} from "@/lib/evaluations/types";

const currentTimestampMs = sql<number>`cast((julianday('now') - 2440587.5) * 86400000 as integer)`;

export type JsonValue = Record<string, unknown>;

export const evaluationVersions = sqliteTable("evaluation_versions", {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    notes: text("notes"),
    agentBaseUrl: text("agent_base_url"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
});

export const evaluationContexts = sqliteTable("evaluation_contexts", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    paramsJson: text("params_json").notNull(),
    headersJson: text("headers_json").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
});

export const evaluationCases = sqliteTable("evaluation_cases", {
    id: text("id").primaryKey(),
    contextId: text("context_id")
        .notNull()
        .references(() => evaluationContexts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    userMessageJson: text("user_message_json").notNull(),
    assistantMessageJson: text("assistant_message_json"),
    metadataJson: text("metadata_json").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
});

export type EvaluationResultStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "timeout";

export const evaluationResults = sqliteTable("evaluation_results", {
    id: text("id").primaryKey(),
    versionId: text("version_id")
        .notNull()
        .references(() => evaluationVersions.id, { onDelete: "cascade" }),
    contextId: text("context_id")
        .notNull()
        .references(() => evaluationContexts.id, { onDelete: "cascade" }),
    caseId: text("case_id")
        .notNull()
        .references(() => evaluationCases.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    status: text("status")
        .notNull()
        .$type<EvaluationResultStatus>()
        .default("pending"),
    requestPayload: text("request_payload").notNull(),
    responseJson: text("response_json").notNull(),
    latencyMs: integer("latency_ms"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
        .notNull()
        .default(currentTimestampMs),
});

export const evaluationResultsRunIndex = index("evaluation_results_run_idx").on(
    evaluationResults.runId,
    evaluationResults.caseId,
);

export const evaluationResultsVersionIndex = index(
    "evaluation_results_version_idx",
).on(evaluationResults.versionId, evaluationResults.createdAt);
