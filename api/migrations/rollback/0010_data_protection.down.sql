-- Rollback for 0010. NOT run automatically. Run manually AFTER reverting the code, and FIRST decrypt the data
-- with the 0010 code still deployed:   php bin/protect-data.php --decrypt
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/rollback/0010_data_protection.down.sql
-- The widened text columns are left as text (older code reads text fine). CVVs dropped by protect-data.php are not
-- restored: older code shows an empty CVV for those cards.
BEGIN;
DROP TABLE IF EXISTS revoked_sessions;
DROP TABLE IF EXISTS chatbot_messages;
ALTER TABLE users DROP COLUMN IF EXISTS totp_last_step;
ALTER TABLE users DROP COLUMN IF EXISTS totp_secret;
COMMIT;
