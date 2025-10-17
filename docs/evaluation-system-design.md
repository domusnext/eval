# Evaluation System High-Level Design

## Goals
- Surface and visualize the scripted evaluation workflow defined in `src/lib/origin.ts`.
- Allow editors to configure per-context request parameters and headers alongside per-case user messages.
- Run evaluations across all cases in a context (or entire version), capture results, and persist them for review.
- Support iterative versioning so evaluators can compare runs over time without overwriting past data.

## System Overview
- **Frontend (Next.js App Router)** renders the evaluation workspace. The primary shell presents a tree editor on the left and detail/editing panels on the right, backed by React Server Components for data loading and Client Components for interactive editing and streaming results.
- **Server Layer (Route Handlers + Server Actions)** orchestrates CRUD for versions/contexts/cases, launches evaluations, and proxies streaming responses from the downstream agent service.
- **Persistence (Drizzle ORM)** defines the relational schema and migrations for the evaluation entities. PostgreSQL (or an existing project database) stores JSON payloads, run metadata, and history.
- **External Agent Service** is the existing SSE endpoint hit by `src/lib/origin.ts:65`. The new platform wraps those calls with structured version/context/case data and records responses.

### High-Level Architecture
- **UI Shell**: `app/(eval)/page.tsx` (new route group) loads the active version and renders `EvaluationWorkspace` composed of:
  - `VersionSwitcher` for creating/selecting versions.
  - `EvaluationTree` for contexts/cases.
  - `ContextEditor` and `CaseEditor` forms.
  - `RunPanel` showing execution controls and live logs/results.
- **APIs** (`app/api/evaluations/*`):
  - `GET /versions`, `POST /versions`, `PATCH /versions/[id]`, etc.
  - Similar endpoints for contexts and cases.
  - `POST /versions/[id]/run` triggers end-to-end evaluation.
- **Execution Service**: A server action/job iterates cases, posts payloads to the agent SSE endpoint, stores incremental tokens, and finalizes results.
- **Result Rendering**: Client components subscribe to server-sent updates over WebSockets (Pusher/Ably) or Next.js `app/api/stream` SSE proxy to show tokens in real time while database writes happen asynchronously.

## Domain Model & Database

### `evaluation_versions`
- `id` (PK, cuid).
- `label` (string) + optional `notes`.
- `created_at`, `created_by`.
- `agent_base_url` (override default target if needed).

### `evaluation_contexts`
- `id` (PK).
- `name` and optional `description`.
- `params_json` (JSONB) storing the editable structure mirroring `params` from `src/lib/origin.ts:5`.
- `headers_json` (JSONB) storing header overrides composed from constants in `src/lib/origin.ts:45`.
- `order_index` for deterministic tree display.

### `evaluation_cases`
- `id` (PK).
- `context_id` (FK → contexts).
- `title`, `description`.
- `user_message_json` (JSONB) storing a serialized `UserModelMessage` object (`role` fixed to `"user"`, `content` using the AI SDK `UserContent` union of text/image/file parts, optional `providerOptions`).
- `assistant_message_json` (JSONB) storing an expected `AssistantModelMessage` payload (text/image/file parts backed by R2 asset URLs plus optional `providerOptions`).
- `metadata_json` (optional JSONB for attachments, expectations, etc.).
- `order_index`.

### `evaluation_results`
- `id` (PK).
- `version_id`, `context_id`, `case_id` (FKs).
- `run_id` (UUID) groups multiple case results from the same execution.
- `status` (`pending`, `running`, `succeeded`, `failed`, `timeout`).
- `request_payload` (JSONB) snapshot of params + user message sent downstream.
- `response_json` (JSONB) storing parsed SSE chunks and aggregated text.
- `latency_ms`, `started_at`, `completed_at`.
- `error` (text) for failures.

Indexes cover `(run_id, case_id)` and `(version_id, created_at DESC)` for history views. Migrations generated through Drizzle reflect these structures.

## User Interface Design
- **Tree Editor**: Left column renders a nested tree: Version (implicit), Context nodes, and child Case nodes. Selecting a node loads its form; drag-and-drop (optional) adjusts `order_index`.
- **Context Editor**: JSON editor for `params`, key-value form for headers, and preview of derived payload shape. Provide safe defaults by cloning the template from `src/lib/origin.ts`.
- **Case Editor**: Structured builders for both user and assistant messages, supporting text/image/file parts, R2 uploads for media, provider options, optional expected response metadata, and inline status.
- **Results Panel**: Tabs for "Run Log" (streamed tokens), "Summary" (latency, status), and "Raw JSON".
- **Version Toolbar**: Buttons for `Run Version`, `Duplicate Version`, `Compare Runs`.

## Evaluation Execution Flow
1. User selects `Run` at version, context, or case level.
2. Server action deletes any prior `evaluation_results` rows for the targeted version/case pairs so the latest run overwrites the version’s snapshot.
3. For each case:
   - Merge the context `params_json` with the case user message (`recent_messages` update mirroring `singleFetch` in `src/lib/origin.ts:60`, but pushing the structured `UserModelMessage` content instead of a raw string).
   - Compose headers from context + defaults (`FamilyIDHeaderKey`, etc.).
   - Stream SSE response via fetch to the agent endpoint.
   - Emit live chunks to the client using a stream proxy.
   - Aggregate final text, update `evaluation_results` with `response_json`, metrics, and timestamps.
4. Once all cases finish, summarize run metrics (success rate, average latency) and expose them in the UI.

Retries and concurrency limits (configurable per context) prevent overloading the agent service, replacing the hard-coded `requestsPerSecond` loop in `src/lib/origin.ts:120`.

## API & Integration Details
- **Configuration**: Agent base URL and default headers live in environment variables (`.dev.vars`) with per-version overrides.
- **Server Actions**: Use Next.js server actions for form submissions and evaluation triggers to keep credentials server-side.
- **Streaming Proxy**: Implement `app/api/evaluations/[runId]/stream/route.ts` that establishes the request to the agent, parses SSE chunks, persists them, and streams JSON fragments to subscribed clients.
- **Validation**: Zod schemas validate params, headers, and `UserModelMessage` payloads (content parts + optional `providerOptions`) before saving or executing to reduce runtime failures.

## Versioning Strategy
- Contexts and cases are global authoring assets; versions only scope evaluation results.
- Creating a new version clears all run history for that version (results start empty until the first run).
- Comparison views show diff of params/headers and highlight result deltas across runs.
- Soft delete (`deleted_at`) columns allow safe rollback without losing history.
- Deleting a version/context/case cascades and removes its associated evaluation results to avoid stale data.

## Observability & Tooling
- Store latency statistics per run and aggregate them for charts.
- Capture agent errors via structured logging; attach log IDs to `evaluation_results`.
- Background job (Next.js `app/api/cron`) can purge old streaming temp data or perform scheduled re-runs.

## Future Enhancements
- Assertions/Scoring: Attach expected outcomes to cases and compute pass/fail automatically.
- Batch Imports: Allow uploading CSV/JSON to seed contexts/cases from external sources.
- Access Control: Integrate with existing auth tables for per-user permissions.
- Load Testing Mode: Reuse the execution pipeline with custom throttling to emulate the behavior of `main()` in `src/lib/origin.ts:152`.
