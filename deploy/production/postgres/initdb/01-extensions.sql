-- Runs once, when the data directory is first initialized. Query statistics for diagnosis
-- (docs/production/RUNBOOK.md, "Slow queries"); `shared_preload_libraries` loads the library.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
