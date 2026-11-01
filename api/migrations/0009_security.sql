-- 0009 security fixes (VAPT 2026-11-02). Additive and idempotent: new tables/columns only, no existing row changed.

-- VAPT-04: failed sign-ins (known or unknown user) for per-identifier and per-IP throttling.
CREATE TABLE IF NOT EXISTS auth_failures (
    id          bigserial PRIMARY KEY,
    identifier  text NOT NULL,            -- lower-cased email or mobile number as typed
    ip          text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_failures_identifier_idx ON auth_failures (identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_failures_ip_idx ON auth_failures (ip, created_at DESC);

-- VAPT-09: tokens issued before sessions_valid_after are rejected, except the token that made the change.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_keep_hash text;

-- VAPT-15: fixed-window counters shared by every php-fpm worker.
CREATE TABLE IF NOT EXISTS rate_limits (
    key           text PRIMARY KEY,
    window_start  timestamptz NOT NULL,
    hits          integer NOT NULL
);
