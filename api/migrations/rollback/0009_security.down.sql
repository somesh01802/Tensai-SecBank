-- Rollback for 0009. NOT run automatically. Run manually AFTER reverting the code:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/rollback/0009_security.down.sql
-- Drops only 0009 objects (throttling history, session cut-off columns, rate-limit counters).
BEGIN;
DROP TABLE IF EXISTS rate_limits;
ALTER TABLE users DROP COLUMN IF EXISTS session_keep_hash;
ALTER TABLE users DROP COLUMN IF EXISTS sessions_valid_after;
DROP TABLE IF EXISTS auth_failures;
COMMIT;
