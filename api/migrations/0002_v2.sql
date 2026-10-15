-- 0002: v2 — mobile+MPIN auth, notifications, account applications, loans,
-- investment autopay, card apps + generated card details, recurring bills,
-- payees, scheduled transfers, rewards, audit logs.

-- users: extra profile fields collected across the new flows
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number varchar(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pan varchar(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dob date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS occupation text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_code varchar(6);
CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_unique
    ON users (mobile_number) WHERE mobile_number IS NOT NULL;

-- MPIN — 6-digit PIN, bcrypt hashed
CREATE TABLE IF NOT EXISTS mpin_credentials (
    user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mpin_hash          text NOT NULL,
    failed_attempts    integer NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- accounts: add human-readable account number + type + display name
DO $$ BEGIN
    CREATE TYPE account_kind AS ENUM (
        'SAVINGS','SALARY','NRI','BUSINESS','INVESTMENT','SYSTEM'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_number varchar(12);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kind account_kind NOT NULL DEFAULT 'SAVINGS';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name text;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_number_unique
    ON accounts (account_number) WHERE account_number IS NOT NULL;

-- account applications
DO $$ BEGIN
    CREATE TYPE application_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_applications (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind           account_kind NOT NULL,
    applicant_name text NOT NULL,
    pan            varchar(10) NOT NULL,
    pin_code       varchar(6) NOT NULL,
    occupation     text NOT NULL,
    mobile_number  varchar(10) NOT NULL,
    extra          jsonb NOT NULL DEFAULT '{}'::jsonb,
    status         application_status NOT NULL DEFAULT 'APPROVED',
    account_id     uuid REFERENCES accounts(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    processed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS account_apps_user_idx ON account_applications (user_id);

-- notifications
DO $$ BEGIN
    CREATE TYPE notification_severity AS ENUM ('INFO','SUCCESS','WARNING','ALERT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS notifications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        text NOT NULL,
    body         text NOT NULL,
    category     text NOT NULL,
    severity     notification_severity NOT NULL DEFAULT 'INFO',
    read_at      timestamptz,
    action_url   text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- loans
CREATE TABLE IF NOT EXISTS loan_products (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code           text NOT NULL,
    name           text NOT NULL,
    description    text,
    interest_rate  numeric(6, 3) NOT NULL,
    min_amount     numeric(20, 2) NOT NULL,
    max_amount     numeric(20, 2) NOT NULL,
    min_tenure     integer NOT NULL,
    max_tenure     integer NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_products_code_unique ON loan_products (code);

DO $$ BEGIN
    CREATE TYPE loan_status AS ENUM
        ('PENDING','APPROVED','REJECTED','DISBURSED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS loan_applications (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id        uuid NOT NULL REFERENCES loan_products(id) ON DELETE RESTRICT,
    principal         numeric(20, 2) NOT NULL,
    tenure_months     integer NOT NULL,
    interest_rate     numeric(6, 3) NOT NULL,
    emi               numeric(20, 2) NOT NULL,
    total_interest    numeric(20, 2) NOT NULL,
    total_repayment   numeric(20, 2) NOT NULL,
    status            loan_status NOT NULL DEFAULT 'PENDING',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_apps_user_idx ON loan_applications (user_id);

-- investment autopay
DO $$ BEGIN
    CREATE TYPE frequency AS ENUM
        ('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY','ONCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS investment_autopay (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    investment_id       uuid NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    source_account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount              numeric(20, 2) NOT NULL,
    frequency           frequency NOT NULL DEFAULT 'MONTHLY',
    next_run_at         timestamptz NOT NULL,
    enabled             boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopay_next_run_idx
    ON investment_autopay (next_run_at) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS investment_autopay_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    autopay_id      uuid NOT NULL REFERENCES investment_autopay(id) ON DELETE CASCADE,
    amount          numeric(20, 2) NOT NULL,
    status          text NOT NULL,
    transaction_id  uuid REFERENCES transactions(id) ON DELETE SET NULL,
    reason          text,
    run_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopay_runs_autopay_idx ON investment_autopay_runs (autopay_id, run_at DESC);

-- card products + applications + extended cards
CREATE TABLE IF NOT EXISTS card_products (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text NOT NULL,
    category     text NOT NULL,         -- EVERYDAY | LIFESTYLE | PREMIUM
    card_type    card_type NOT NULL,    -- CREDIT | DEBIT
    name         text NOT NULL,
    tagline      text,
    benefits     jsonb NOT NULL DEFAULT '[]'::jsonb,
    annual_fee   numeric(20, 2) NOT NULL DEFAULT 0,
    color_hint   text NOT NULL DEFAULT 'peach',
    network      text NOT NULL DEFAULT 'MASTERCARD',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS card_products_code_unique ON card_products (code);

CREATE TABLE IF NOT EXISTS card_applications (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id     uuid NOT NULL REFERENCES card_products(id) ON DELETE RESTRICT,
    mobile_number  varchar(10) NOT NULL,
    pan            varchar(10) NOT NULL,
    dob            date NOT NULL,
    status         application_status NOT NULL DEFAULT 'APPROVED',
    card_id        uuid REFERENCES cards(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    processed_at   timestamptz
);

-- Full 16-digit card number is stored (demo only); frontend masks by default.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES card_products(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS full_number varchar(16);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS cvv varchar(3);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'MASTERCARD';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- recurring bills + runs
CREATE TABLE IF NOT EXISTS recurring_bills (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    biller_name         text NOT NULL,
    category            text NOT NULL,
    provider_hint       text,
    amount              numeric(20, 2) NOT NULL,
    auto_detect_amount  boolean NOT NULL DEFAULT false,
    frequency           frequency NOT NULL DEFAULT 'MONTHLY',
    source_account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
    autopay_enabled     boolean NOT NULL DEFAULT true,
    next_run_at         timestamptz NOT NULL,
    enabled             boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_bills_user_idx ON recurring_bills (user_id);
CREATE INDEX IF NOT EXISTS recurring_bills_next_run_idx
    ON recurring_bills (next_run_at) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS recurring_bill_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recurring_bill_id   uuid NOT NULL REFERENCES recurring_bills(id) ON DELETE CASCADE,
    amount              numeric(20, 2) NOT NULL,
    status              text NOT NULL,
    reason              text,
    transaction_id      uuid REFERENCES transactions(id) ON DELETE SET NULL,
    bill_id             uuid REFERENCES bills(id) ON DELETE SET NULL,
    run_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_bill_runs_idx ON recurring_bill_runs (recurring_bill_id, run_at DESC);

-- payees (replaces beneficiaries at the UX layer)
CREATE TABLE IF NOT EXISTS payees (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bank_name            text NOT NULL,
    account_number       varchar(20) NOT NULL,
    account_holder_name  text NOT NULL,
    nickname             text NOT NULL,
    active               boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payees_user_idx ON payees (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS payees_user_acct_unique
    ON payees (user_id, account_number);

-- scheduled transfers
DO $$ BEGIN
    CREATE TYPE scheduled_transfer_status AS ENUM
        ('SCHEDULED','PROCESSING','COMPLETED','FAILED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS scheduled_transfers (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payee_id             uuid NOT NULL REFERENCES payees(id) ON DELETE RESTRICT,
    source_account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount               numeric(20, 2) NOT NULL,
    remarks              text,
    frequency            frequency NOT NULL DEFAULT 'ONCE',
    next_run_at          timestamptz NOT NULL,
    enabled              boolean NOT NULL DEFAULT true,
    status               scheduled_transfer_status NOT NULL DEFAULT 'SCHEDULED',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_transfers_user_idx ON scheduled_transfers (user_id);
CREATE INDEX IF NOT EXISTS scheduled_transfers_next_run_idx
    ON scheduled_transfers (next_run_at) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS scheduled_transfer_runs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_transfer_id uuid NOT NULL REFERENCES scheduled_transfers(id) ON DELETE CASCADE,
    amount                numeric(20, 2) NOT NULL,
    status                text NOT NULL,
    reason                text,
    transaction_id        uuid REFERENCES transactions(id) ON DELETE SET NULL,
    run_at                timestamptz NOT NULL DEFAULT now()
);

-- rewards
CREATE TABLE IF NOT EXISTS reward_tasks (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 text NOT NULL,
    title                text NOT NULL,
    description          text NOT NULL,
    points               integer NOT NULL,
    completion_condition text NOT NULL,
    category             text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reward_tasks_code_unique ON reward_tasks (code);

CREATE TABLE IF NOT EXISTS user_reward_tasks (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id        uuid NOT NULL REFERENCES reward_tasks(id) ON DELETE CASCADE,
    completed_at   timestamptz NOT NULL DEFAULT now(),
    points_awarded integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_reward_task_unique
    ON user_reward_tasks (user_id, task_id);
CREATE INDEX IF NOT EXISTS user_reward_tasks_user_idx ON user_reward_tasks (user_id);

-- audit log
CREATE TABLE IF NOT EXISTS audit_logs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    event_type   text NOT NULL,
    entity       text,
    entity_id    uuid,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip           text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_event_idx ON audit_logs (event_type, created_at DESC);
