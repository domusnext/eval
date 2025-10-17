DROP TABLE IF EXISTS evaluation_results;
DROP TABLE IF EXISTS evaluation_cases;
DROP TABLE IF EXISTS evaluation_contexts;
DROP TABLE IF EXISTS evaluation_versions;
DROP TABLE IF EXISTS todos;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS verification;
DROP TABLE IF EXISTS user;

CREATE TABLE evaluation_versions (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    notes TEXT,
    agent_base_url TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE evaluation_contexts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    params_json TEXT NOT NULL DEFAULT '{}',
    headers_json TEXT NOT NULL DEFAULT '{}',
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE evaluation_cases (
    id TEXT PRIMARY KEY NOT NULL,
    context_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    user_message_json TEXT NOT NULL,
    assistant_message_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (context_id) REFERENCES evaluation_contexts(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE evaluation_results (
    id TEXT PRIMARY KEY NOT NULL,
    version_id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    response_json TEXT NOT NULL,
    latency_ms INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (version_id) REFERENCES evaluation_versions(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    FOREIGN KEY (context_id) REFERENCES evaluation_contexts(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    FOREIGN KEY (case_id) REFERENCES evaluation_cases(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX evaluation_results_run_idx ON evaluation_results (run_id, case_id);
CREATE INDEX evaluation_results_version_idx ON evaluation_results (version_id, created_at);
