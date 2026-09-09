-- 0003: primary-account flag, account/loan closure timestamps, welcome bonus categorization.

-- Primary flag
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

-- Closure timestamps (status column already carries CLOSED enum value)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS close_reason text;

-- Ensure at most one primary account per user
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_primary_unique
    ON accounts (user_id) WHERE is_primary = true;

-- Backfill: whichever non-SYSTEM account was created first per user becomes primary.
UPDATE accounts a SET is_primary = true
WHERE a.id IN (
    SELECT DISTINCT ON (user_id) id
    FROM accounts
    WHERE kind <> 'SYSTEM'
    ORDER BY user_id, created_at ASC
) AND NOT EXISTS (
    SELECT 1 FROM accounts WHERE user_id = a.user_id AND is_primary = true
);
