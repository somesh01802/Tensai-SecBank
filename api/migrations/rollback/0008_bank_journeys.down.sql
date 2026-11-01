-- Rollback for 0008. NOT run automatically. Run manually AFTER reverting the code:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/rollback/0008_bank_journeys.down.sql
-- Destroys only 0008 data (journey events, disputes, lookups, segment/branch).
-- Pre-existing users, accounts, ledger, transactions and attempts are untouched,
-- except that CARD attempts must be removed to restore the old kind constraint.
BEGIN;
DROP TABLE IF EXISTS disputes;
DROP TABLE IF EXISTS journey_events;
DELETE FROM transaction_attempts WHERE kind = 'CARD';
ALTER TABLE transaction_attempts DROP CONSTRAINT IF EXISTS transaction_attempts_kind_check;
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_kind_check CHECK (kind IN ('P2P', 'EXTERNAL', 'BILL'));
DROP TRIGGER IF EXISTS users_bank_defaults ON users;
DROP FUNCTION IF EXISTS users_bank_defaults();
DROP FUNCTION IF EXISTS bank_segment_for(uuid);
DROP FUNCTION IF EXISTS bank_branch_for(uuid);
ALTER TABLE users DROP COLUMN IF EXISTS home_branch_id;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_segment_check;
ALTER TABLE users DROP COLUMN IF EXISTS segment;
DROP TABLE IF EXISTS bank_journey_steps;
DROP TABLE IF EXISTS bank_journeys;
DROP TABLE IF EXISTS bank_branches;
DROP TABLE IF EXISTS bank_regions;
COMMIT;
