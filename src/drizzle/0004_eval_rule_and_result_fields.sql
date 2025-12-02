-- Migration: Rename assistantMessageJson to evalRule and add evaluation fields
-- 1. Rename assistant_message_json to eval_rule in evaluation_cases
-- 2. Add result_overview and score to evaluation_results

-- Step 1: Rename column in evaluation_cases
ALTER TABLE evaluation_cases RENAME COLUMN assistant_message_json TO eval_rule;

-- Step 2: Add new columns to evaluation_results
ALTER TABLE evaluation_results ADD COLUMN result_overview TEXT;
ALTER TABLE evaluation_results ADD COLUMN score INTEGER;
