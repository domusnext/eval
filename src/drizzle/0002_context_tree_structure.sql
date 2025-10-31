-- Migration: Add tree structure support to evaluation_contexts
-- This migration updates the evaluation_contexts table to support parent-child relationships
-- and separates environment, headers, and recent_messages

-- Disable foreign key constraints temporarily
PRAGMA foreign_keys = OFF;

-- Step 1: Drop existing tables in correct order
DROP TABLE IF EXISTS evaluation_results;
DROP TABLE IF EXISTS evaluation_cases;
DROP TABLE IF EXISTS evaluation_contexts;

CREATE TABLE evaluation_contexts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,

    -- Tree structure fields
    parent_context_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    child_count INTEGER NOT NULL DEFAULT 0,

    -- Separated configuration (incremental storage)
    environment_json TEXT NOT NULL DEFAULT '{}',
    headers_json TEXT NOT NULL DEFAULT '{}',
    recent_messages_json TEXT NOT NULL DEFAULT '[]',

    -- Timestamps
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    -- Self-referential foreign key for parent-child relationship
    FOREIGN KEY (parent_context_id) REFERENCES evaluation_contexts(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Create indexes for tree navigation
CREATE INDEX evaluation_contexts_parent_idx ON evaluation_contexts (parent_context_id);
CREATE INDEX evaluation_contexts_depth_idx ON evaluation_contexts (depth);

-- Step 3: Recreate evaluation_cases with root_context_id
CREATE TABLE evaluation_cases (
    id TEXT PRIMARY KEY NOT NULL,
    root_context_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    user_message_json TEXT NOT NULL,
    assistant_message_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    order_index INTEGER NOT NULL DEFAULT 0,

    -- Run summary (denormalized for performance)
    last_run_status TEXT,
    last_run_duration_ms INTEGER,
    last_run_completed_at TEXT,
    last_run_response_content TEXT,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    -- Cases reference root contexts only
    FOREIGN KEY (root_context_id) REFERENCES evaluation_contexts(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Create index for case lookups
CREATE INDEX evaluation_cases_root_context_idx ON evaluation_cases (root_context_id);

-- Step 4: Recreate evaluation_results table
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

-- Create indexes for evaluation_results
CREATE INDEX evaluation_results_run_idx ON evaluation_results (run_id, case_id);
CREATE INDEX evaluation_results_version_idx ON evaluation_results (version_id, created_at);

-- Re-enable foreign key constraints
PRAGMA foreign_keys = ON;
