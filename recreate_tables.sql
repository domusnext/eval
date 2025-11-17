-- Drop old tables in correct order (reverse dependency)
DROP TABLE IF EXISTS evaluation_results;
DROP TABLE IF EXISTS evaluation_cases;
DROP TABLE IF EXISTS evaluation_contexts;
DROP TABLE IF EXISTS evaluation_versions;
