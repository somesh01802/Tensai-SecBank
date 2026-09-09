-- 0001: dashboard entities — investments, cards, bills + transaction category

DO $$ BEGIN
    CREATE TYPE investment_type AS ENUM (
        'MUTUAL_FUND', 'LIFE_INSURANCE', 'FIXED_DEPOSIT', 'STOCKS', 'RECURRING_DEPOSIT'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE card_type AS ENUM ('CREDIT', 'DEBIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE bill_status AS ENUM ('DUE', 'PAID', 'OVERDUE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS investments (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                  investment_type NOT NULL,
    name                  text NOT NULL,
    invested_amount       numeric(20, 2) NOT NULL DEFAULT 0,
    current_value         numeric(20, 2) NOT NULL DEFAULT 0,
    monthly_contribution  numeric(20, 2),
    return_pct            numeric(8, 2),
    frequency_label       text,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS investments_user_idx ON investments(user_id);

CREATE TABLE IF NOT EXISTS cards (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
    holder_name   text NOT NULL,
    last_four     varchar(4) NOT NULL,
    expiry_month  integer NOT NULL,
    expiry_year   integer NOT NULL,
    type          card_type NOT NULL,
    brand         text NOT NULL DEFAULT 'MASTERCARD',
    color_hint    text NOT NULL DEFAULT 'peach',
    is_frozen     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_user_idx ON cards(user_id);

CREATE TABLE IF NOT EXISTS bills (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    biller_name   text NOT NULL,
    category      text NOT NULL,
    icon_hint     text,
    amount        numeric(20, 2) NOT NULL,
    due_date      date,
    status        bill_status NOT NULL DEFAULT 'DUE',
    paid_at       timestamptz,
    paid_tx_id    uuid REFERENCES transactions(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bills_user_idx ON bills(user_id);
CREATE INDEX IF NOT EXISTS bills_status_idx ON bills(status);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category text;
