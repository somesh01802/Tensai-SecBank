-- 0010 data protection and session hardening (VAPT 2026-11-02). Additive and idempotent.
-- Values are encrypted by the application (key APP_DATA_KEY in api/.env); `bin/protect-data.php` converts existing
-- plaintext in place. Widening varchar to text keeps every existing value.

-- VAPT-06 / VAPT-20: encrypted values ("enc:v1:...") need more room than varchar(10/16).
ALTER TABLE cards ALTER COLUMN full_number TYPE text;
ALTER TABLE users ALTER COLUMN pan TYPE text;
ALTER TABLE account_applications ALTER COLUMN pan TYPE text;
ALTER TABLE card_applications ALTER COLUMN pan TYPE text;
ALTER TABLE card_applications ALTER COLUMN dob TYPE text;

-- VAPT-04: authenticator (TOTP) second factor for admin sign-in; secret stored encrypted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;

-- VAPT-15: chatbot history kept by the server; the client can no longer write assistant turns.
CREATE TABLE IF NOT EXISTS chatbot_messages (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('user', 'assistant')),
    content     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chatbot_messages_user_idx ON chatbot_messages (user_id, id DESC);

-- VAPT-09: revoked session ids (logout ends the whole sliding session, not only the presented token).
CREATE TABLE IF NOT EXISTS revoked_sessions (
    sid         text PRIMARY KEY,
    expires_at  timestamptz NOT NULL
);
