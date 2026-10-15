-- Tensai SecBank now operates in United States dollars.
-- Existing ledger amounts are unchanged; only account currency metadata moves to USD.
UPDATE accounts SET currency = 'USD' WHERE currency IS NULL OR currency <> 'USD';
ALTER TABLE accounts ALTER COLUMN currency SET DEFAULT 'USD';