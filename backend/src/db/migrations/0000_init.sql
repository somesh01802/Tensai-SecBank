-- Tensai SecBank — initial schema
-- Idempotent: safe to run on every dev boot.

DO $$ BEGIN
    CREATE TYPE account_status AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE transaction_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE ledger_type AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    name          text NOT NULL,
    password_hash text NOT NULL,
    is_system_user boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS accounts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency   varchar(3) NOT NULL DEFAULT 'INR',
    status     account_status NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id);
CREATE INDEX IF NOT EXISTS accounts_user_status_idx ON accounts (user_id, status);

CREATE TABLE IF NOT EXISTS transactions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    to_account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount           numeric(20, 2) NOT NULL,
    status           transaction_status NOT NULL DEFAULT 'PENDING',
    idempotency_key  text NOT NULL,
    description      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_key_unique ON transactions (idempotency_key);
CREATE INDEX IF NOT EXISTS transactions_from_idx ON transactions (from_account_id);
CREATE INDEX IF NOT EXISTS transactions_to_idx ON transactions (to_account_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    type           ledger_type NOT NULL,
    amount         numeric(20, 2) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_account_idx ON ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS ledger_transaction_idx ON ledger_entries (transaction_id);

CREATE TABLE IF NOT EXISTS beneficiaries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    nickname      text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beneficiaries_user_idx ON beneficiaries (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS beneficiaries_user_account_unique ON beneficiaries (user_id, to_account_id);

CREATE TABLE IF NOT EXISTS revoked_tokens (
    token       text PRIMARY KEY,
    expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_expires_idx ON revoked_tokens (expires_at);
