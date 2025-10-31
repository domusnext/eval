# Database Migration Guide - Context Tree Structure

## Overview

Migration `0002_context_tree_structure.sql` adds support for hierarchical tree structure to evaluation contexts with the following changes:

### Changes to `evaluation_contexts` table:

**Removed fields:**
- `params_json` - Split into separate fields
- `order_index` - No longer needed with tree structure

**Added fields:**
- `parent_context_id` (TEXT) - References parent context (NULL for root contexts)
- `depth` (INTEGER) - Tree depth level (0 for root, increments for children)
- `child_count` (INTEGER) - Number of direct children
- `environment_json` (TEXT) - Contains family_info, user_brief, chat_info
- `recent_messages_json` (TEXT) - Array of incremental messages

**Updated fields:**
- `headers_json` - Remains but used for incremental storage only

### Changes to `evaluation_cases` table:

**Updated fields:**
- `context_id` → `root_context_id` - Cases now reference root contexts only

**Added fields:**
- `last_run_status` (TEXT) - Cached status from last run
- `last_run_duration_ms` (INTEGER) - Cached duration
- `last_run_completed_at` (TEXT) - Cached completion time
- `last_run_response_content` (TEXT) - Cached response

## Tree Structure Features

### Incremental Storage
- Each context node stores only NEW data (environment, headers, messages)
- Full configuration is resolved at runtime by merging parent chain

### Configuration Inheritance
- **Environment**: Child overrides parent (覆盖式继承)
- **Headers**: Child overrides parent
- **Messages**: Appended (parent messages + child messages)

### Tree Limits
- Maximum depth: 10 levels
- Maximum children per node: 50

### Multiple Root Contexts
- Each version can have multiple root contexts (forest structure)
- Cases are attached to root contexts only
- Children contexts are created via "Save to Context" feature

## How to Run Migration

### Local Development
\`\`\`bash
npm run db:migrate:local
\`\`\`

### Preview Environment
\`\`\`bash
npm run db:migrate:preview
\`\`\`

### Production
\`\`\`bash
npm run db:migrate:prod
\`\`\`

## Verification

After migration, verify the schema:

### Local
\`\`\`bash
npm run db:inspect:local
\`\`\`

### Check specific table structure
\`\`\`bash
wrangler d1 execute eval-evaluations --local --command="PRAGMA table_info(evaluation_contexts);"
wrangler d1 execute eval-evaluations --local --command="PRAGMA table_info(evaluation_cases);"
\`\`\`

## Data Migration Notes

⚠️ **Important**: This migration will **DROP and RECREATE** the tables, clearing all existing data.

This is intentional as per the requirement to "clear and rebuild" the database structure.

If you need to preserve existing data:
1. Export current data before migration
2. Transform the data to new structure
3. Re-import after migration

## Rollback

To rollback, you can manually run the previous migration:

\`\`\`bash
wrangler d1 execute eval-evaluations --local --file=src/drizzle/0001_create_evaluations.sql
\`\`\`

## Testing the New Structure

After migration, test:

1. Create a root context with environment
2. Create a case under root context
3. Run the case
4. Save case result as child context (will inherit parent's environment)
5. Verify child context shows merged configuration
6. Create another child from the first child (depth 2)
7. Verify full configuration chain resolves correctly
