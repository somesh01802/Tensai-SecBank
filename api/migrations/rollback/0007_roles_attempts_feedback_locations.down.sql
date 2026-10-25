-- Rollback for 0007. NOT run automatically (bin/migrate.php only reads
-- migrations/*.sql, not this sub-directory). Run manually AFTER reverting the
-- application code, and only if required:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/rollback/0007_roles_attempts_feedback_locations.down.sql
-- Destroys only data created by 0007 features (attempts, feedback, locations,
-- roles, synthetic flags). Pre-existing users, accounts, ledger and
-- transactions are untouched. Take a pg_dump first.
BEGIN;
DROP TABLE IF EXISTS transaction_feedback;
DROP TABLE IF EXISTS transaction_attempts;
DROP TABLE IF EXISTS login_locations;
DROP INDEX IF EXISTS login_events_session_idx;
ALTER TABLE login_events DROP COLUMN IF EXISTS session_id;
DROP INDEX IF EXISTS users_role_idx;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP COLUMN IF EXISTS role;
ALTER TABLE users DROP COLUMN IF EXISTS is_synthetic;
DROP INDEX IF EXISTS audit_logs_created_idx;
DROP INDEX IF EXISTS audit_logs_event_idx;
COMMIT;
