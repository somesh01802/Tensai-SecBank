-- 0007: role-based access, synthetic-user flag, transaction attempts (success
-- AND failure), post-transaction feedback, login locations.
-- Additive + idempotent: no existing column/row is changed except the
-- is_synthetic backfill for known test-data email domains.
-- Rollback: migrations/rollback/0007_roles_attempts_feedback_locations.down.sql

-- ---- roles (never settable via public registration) ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'CUSTOMER';
DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER', 'ADMIN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- synthetic (test) users: seeded + load-test pools ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;
UPDATE users SET is_synthetic = true
 WHERE is_synthetic = false
   AND (email LIKE '%@tensai.test' OR email LIKE '%@loadtest.tensai.test');
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role) WHERE role <> 'CUSTOMER';

-- ---- login session correlation ----
ALTER TABLE login_events ADD COLUMN IF NOT EXISTS session_id uuid;
CREATE INDEX IF NOT EXISTS login_events_session_idx ON login_events (session_id);

-- ---- login locations (browser geolocation, consent-based) ----
CREATE TABLE IF NOT EXISTS login_locations (
    id              bigserial PRIMARY KEY,
    login_event_id  bigint NOT NULL UNIQUE REFERENCES login_events(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      uuid,
    status          text NOT NULL CHECK (status IN ('granted', 'denied', 'dismissed', 'unavailable', 'timeout', 'error')),
    latitude        numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
    longitude       numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m      numeric(12, 2) CHECK (accuracy_m >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- coordinates exist if and only if the user granted permission
    CONSTRAINT login_locations_coords_iff_granted
        CHECK ((status = 'granted') = (latitude IS NOT NULL AND longitude IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS login_locations_user_idx ON login_locations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_locations_created_idx ON login_locations (created_at);

-- ---- every money-movement attempt, successful or not ----
CREATE TABLE IF NOT EXISTS transaction_attempts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        uuid,
    kind              text NOT NULL CHECK (kind IN ('P2P', 'EXTERNAL', 'BILL')),
    category          text,
    amount            numeric(20, 2),
    currency          varchar(3) NOT NULL DEFAULT 'USD',
    source_account_id uuid,                -- no FK: an attempt may name a non-existent account
    target            text,                -- masked display only (e.g. "HDFC Bank ••••1234")
    transaction_id    uuid REFERENCES transactions(id) ON DELETE SET NULL,
    outcome           text NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
    error_category    text,
    error_message     text,
    http_status       integer,
    duration_ms       integer CHECK (duration_ms >= 0),
    trace_id          text,
    idempotency_key   text,
    is_synthetic      boolean NOT NULL DEFAULT false,
    fault_injected    boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transaction_attempts_failure_has_category
        CHECK (outcome = 'SUCCESS' OR error_category IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS transaction_attempts_user_idx ON transaction_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transaction_attempts_created_idx ON transaction_attempts (created_at);
CREATE INDEX IF NOT EXISTS transaction_attempts_tx_idx ON transaction_attempts (transaction_id);
CREATE INDEX IF NOT EXISTS transaction_attempts_outcome_idx ON transaction_attempts (outcome, error_category);

-- ---- post-transaction feedback (one per attempt) ----
CREATE TABLE IF NOT EXISTS transaction_feedback (
    id          bigserial PRIMARY KEY,
    attempt_id  uuid NOT NULL UNIQUE REFERENCES transaction_attempts(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      text NOT NULL CHECK (status IN ('SUBMITTED', 'DISMISSED')),
    rating      text CHECK (rating IN ('HAPPY', 'SATISFIED', 'NOT_SATISFIED')),
    comment     text CHECK (char_length(comment) <= 500),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transaction_feedback_rating_iff_submitted
        CHECK ((status = 'SUBMITTED') = (rating IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS transaction_feedback_user_idx ON transaction_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transaction_feedback_created_idx ON transaction_feedback (created_at);

-- ---- admin audit lookups (audit_logs table exists since 0002) ----
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_event_idx ON audit_logs (event_type, created_at DESC);
