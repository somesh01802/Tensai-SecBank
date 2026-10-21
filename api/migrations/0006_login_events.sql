-- 0006: durable per-login audit. Lets Kibana (via the PHP APM agent) answer
-- "who logged in, when, and how many times" and keeps the same record in
-- Postgres. Idempotent — safe to re-run against the live DB, touches no
-- existing data.
CREATE TABLE IF NOT EXISTS login_events (
    id          bigserial PRIMARY KEY,
    user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
    username    text NOT NULL,
    email       text,
    event       text NOT NULL DEFAULT 'login',    -- 'login' | 'register'
    outcome     text NOT NULL DEFAULT 'success',   -- 'success' | 'failure'
    method      text,                              -- 'password' | 'mpin'
    ip          text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_events_user_idx     ON login_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_username_idx ON login_events (username, created_at DESC);
