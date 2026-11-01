-- 0008: business-journey telemetry for the SecBank dashboards (D0-D9).
-- Additive + idempotent (re-run on every migrate): new lookup tables, two new
-- user attributes backfilled deterministically ONLY where NULL, journey step
-- events, disputes. No existing row value is changed.
-- Rollback: migrations/rollback/0008_bank_journeys.down.sql

-- ---- lookups: regions, branches (BR-001..BR-040), journeys, step catalogue ----
CREATE TABLE IF NOT EXISTS bank_regions (
    id    text PRIMARY KEY,
    name  text NOT NULL
);
INSERT INTO bank_regions (id, name) VALUES
    ('pacific', 'Pacific'), ('midwest', 'Midwest'), ('northeast', 'Northeast'),
    ('west', 'West'), ('south', 'South'), ('southeast', 'Southeast')
ON CONFLICT (id) DO NOTHING;

-- Branch ids / per-region counts follow the D2 wireframe. City coordinates are an
-- assumption (the spec gives none): one real US metro per branch.
CREATE TABLE IF NOT EXISTS bank_branches (
    id         text PRIMARY KEY CHECK (id ~ '^BR-[0-9]{3}$'),
    name       text NOT NULL,
    region_id  text NOT NULL REFERENCES bank_regions(id),
    latitude   numeric(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude  numeric(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    atm_count  integer NOT NULL DEFAULT 3 CHECK (atm_count >= 0)
);
INSERT INTO bank_branches (id, name, region_id, latitude, longitude) VALUES
    ('BR-001','Seattle','pacific',47.6062,-122.3321), ('BR-002','Portland','pacific',45.5152,-122.6784),
    ('BR-003','San Francisco','pacific',37.7749,-122.4194), ('BR-004','Los Angeles','pacific',34.0522,-118.2437),
    ('BR-005','San Diego','pacific',32.7157,-117.1611), ('BR-006','Sacramento','pacific',38.5816,-121.4944),
    ('BR-007','Chicago','midwest',41.8781,-87.6298), ('BR-008','Detroit','midwest',42.3314,-83.0458),
    ('BR-009','Minneapolis','midwest',44.9778,-93.2650), ('BR-010','Columbus','midwest',39.9612,-82.9988),
    ('BR-011','Indianapolis','midwest',39.7684,-86.1581), ('BR-012','Milwaukee','midwest',43.0389,-87.9065),
    ('BR-013','St. Louis','midwest',38.6270,-90.1994),
    ('BR-014','New York','northeast',40.7128,-74.0060), ('BR-015','Boston','northeast',42.3601,-71.0589),
    ('BR-016','Philadelphia','northeast',39.9526,-75.1652), ('BR-017','Pittsburgh','northeast',40.4406,-79.9959),
    ('BR-018','Hartford','northeast',41.7658,-72.6734), ('BR-019','Providence','northeast',41.8240,-71.4128),
    ('BR-020','Newark','northeast',40.7357,-74.1724), ('BR-021','Buffalo','northeast',42.8864,-78.8784),
    ('BR-022','Denver','west',39.7392,-104.9903), ('BR-023','Phoenix','west',33.4484,-112.0740),
    ('BR-024','Salt Lake City','west',40.7608,-111.8910), ('BR-025','Las Vegas','west',36.1699,-115.1398),
    ('BR-026','Albuquerque','west',35.0844,-106.6504), ('BR-027','Boise','west',43.6150,-116.2023),
    ('BR-028','Dallas','south',32.7767,-96.7970), ('BR-029','Houston','south',29.7604,-95.3698),
    ('BR-030','Austin','south',30.2672,-97.7431), ('BR-031','San Antonio','south',29.4241,-98.4936),
    ('BR-032','Oklahoma City','south',35.4676,-97.5164), ('BR-033','Nashville','south',36.1627,-86.7816),
    ('BR-034','Atlanta','southeast',33.7490,-84.3880), ('BR-035','Miami','southeast',25.7617,-80.1918),
    ('BR-036','Charlotte','southeast',35.2271,-80.8431), ('BR-037','Tampa','southeast',27.9506,-82.4572),
    ('BR-038','Orlando','southeast',28.5383,-81.3792), ('BR-039','Raleigh','southeast',35.7796,-78.6382),
    ('BR-040','Jacksonville','southeast',30.3322,-81.6557)
ON CONFLICT (id) DO NOTHING;

-- Completion SLOs: bill_pay 99, onboarding 92, login 99.5, card_payment 99 are from
-- the spec; the rest are assumptions (loan_apply must sit below its 86% to be
-- "healthy", per the D0 note). p95 targets: bill_pay 20 s from the spec, rest assumed.
CREATE TABLE IF NOT EXISTS bank_journeys (
    name                text PRIMARY KEY,
    label               text NOT NULL,
    slo_completion_pct  numeric(5, 2) NOT NULL CHECK (slo_completion_pct BETWEEN 0 AND 100),
    p95_target_ms       integer NOT NULL CHECK (p95_target_ms > 0)
);
INSERT INTO bank_journeys (name, label, slo_completion_pct, p95_target_ms) VALUES
    ('login','Login',99.5,8000), ('onboarding','Onboarding',92,480000), ('view_accounts','View accounts',99.5,3000),
    ('bill_pay','Bill pay',99,20000), ('autopay_setup','Autopay setup',95,30000), ('p2p_transfer','P2P transfer',97,20000),
    ('card_payment','Card payment',99,5000), ('card_controls','Card controls',99,6000),
    ('loan_apply','Loan apply',85,720000), ('dispute','Dispute',97,240000)
ON CONFLICT (name) DO NOTHING;

-- Step catalogue (LOOKUP JOIN target for step latency). bill_pay is from the spec;
-- other journeys' steps are assumptions kept to what the app actually does.
CREATE TABLE IF NOT EXISTS bank_journey_steps (
    journey     text NOT NULL REFERENCES bank_journeys(name),
    step        text NOT NULL,
    step_index  integer NOT NULL CHECK (step_index > 0),
    label       text NOT NULL,
    target_ms   integer NOT NULL CHECK (target_ms > 0),
    services    text NOT NULL,
    is_final    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (journey, step),
    UNIQUE (journey, step_index)
);
INSERT INTO bank_journey_steps (journey, step, step_index, label, target_ms, services, is_final) VALUES
    ('login','sign_in',1,'Sign in',2000,'web-ui, auth-svc',true),
    ('onboarding','register',1,'Register',3000,'web-ui, auth-svc',false),
    ('onboarding','open_account',2,'Open account',3000,'accounts-svc',true),
    ('view_accounts','load_accounts',1,'Load accounts',1500,'accounts-svc',true),
    ('bill_pay','sign_in',1,'Sign in',2000,'web-ui, auth-svc',false),
    ('bill_pay','choose_biller',2,'Choose biller',1500,'accounts-svc',false),
    ('bill_pay','enter_amount',3,'Enter amount',1000,'web-ui',false),
    ('bill_pay','confirm_payment',4,'Confirm payment',3000,'payments-svc, payment_gw',false),
    ('bill_pay','receipt',5,'Receipt',1000,'notify-svc',true),
    ('autopay_setup','choose_payee',1,'Choose payee',1500,'web-ui',false),
    ('autopay_setup','confirm_autopay',2,'Confirm autopay',3000,'transfers-svc',true),
    ('p2p_transfer','choose_payee',1,'Choose payee',1500,'web-ui',false),
    ('p2p_transfer','enter_amount',2,'Enter amount',1000,'web-ui',false),
    ('p2p_transfer','verify_otp',3,'Verify OTP',5000,'auth-svc, sms_otp',false),
    ('p2p_transfer','confirm_transfer',4,'Confirm transfer',3000,'transfers-svc',true),
    ('card_payment','authorize',1,'Authorize',3000,'cards-svc, card_processor, fraud-engine',true),
    ('card_controls','change_control',1,'Change control',2000,'cards-svc',true),
    ('loan_apply','choose_product',1,'Choose product',1500,'web-ui',false),
    ('loan_apply','submit_application',2,'Submit application',5000,'accounts-svc',true),
    ('dispute','select_transaction',1,'Select transaction',1500,'web-ui',false),
    ('dispute','submit_dispute',2,'Submit dispute',3000,'accounts-svc',true)
ON CONFLICT (journey, step) DO NOTHING;

-- ---- customer attributes (deterministic, only filled where NULL) ----
-- Segment shares are an assumption: retail 76 %, premier 15 %, SME 9 % (SME 9 % is from D1).
ALTER TABLE users ADD COLUMN IF NOT EXISTS segment text;
DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_segment_check CHECK (segment IN ('retail', 'premier', 'sme'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_branch_id text REFERENCES bank_branches(id);
CREATE OR REPLACE FUNCTION bank_segment_for(uid uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN abs(hashtext(uid::text || '|segment')) % 100 < 76 THEN 'retail'
                WHEN abs(hashtext(uid::text || '|segment')) % 100 < 91 THEN 'premier'
                ELSE 'sme' END $$;
CREATE OR REPLACE FUNCTION bank_branch_for(uid uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT 'BR-' || lpad((abs(hashtext(uid::text || '|branch')) % 40 + 1)::text, 3, '0') $$;
UPDATE users SET segment = bank_segment_for(id) WHERE segment IS NULL;
UPDATE users SET home_branch_id = bank_branch_for(id) WHERE home_branch_id IS NULL;
-- new registrations get the same deterministic values (every insert path, no app change)
CREATE OR REPLACE FUNCTION users_bank_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.segment := COALESCE(NEW.segment, bank_segment_for(NEW.id));
    NEW.home_branch_id := COALESCE(NEW.home_branch_id, bank_branch_for(NEW.id));
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_bank_defaults ON users;
CREATE TRIGGER users_bank_defaults BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_bank_defaults();

-- ---- card payments are attempts too ----
ALTER TABLE transaction_attempts DROP CONSTRAINT IF EXISTS transaction_attempts_kind_check;
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_kind_check
    CHECK (kind IN ('P2P', 'EXTERNAL', 'BILL', 'CARD'));

-- ---- one row per journey step (exported to logs-bank.business-default) ----
CREATE TABLE IF NOT EXISTS journey_events (
    id               bigserial PRIMARY KEY,
    journey_id       uuid NOT NULL,
    journey          text NOT NULL REFERENCES bank_journeys(name),
    step             text NOT NULL,
    step_index       integer NOT NULL,
    status           text CHECK (status IN ('started', 'completed', 'abandoned', 'failed', 'pending')),
    outcome          text NOT NULL CHECK (outcome IN ('success', 'failure')),
    reason_code      text,
    failure_class    text CHECK (failure_class IN ('technical', 'business', 'user')),
    amount           numeric(20, 2),
    currency         varchar(3) NOT NULL DEFAULT 'USD',
    channel          text NOT NULL CHECK (channel IN ('web', 'mobile_web', 'branch', 'atm', 'partner_api')),
    device           text,
    browser          text,
    user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
    session_id       uuid,
    attempt_id       uuid,
    trace_id         text,
    http_status      integer,
    duration_ms      integer CHECK (duration_ms >= 0),
    journey_duration_ms bigint CHECK (journey_duration_ms >= 0),
    is_synthetic     boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (journey, step) REFERENCES bank_journey_steps(journey, step),
    CONSTRAINT journey_events_failure_has_reason CHECK (outcome = 'success' OR reason_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS journey_events_created_idx ON journey_events (created_at);
CREATE INDEX IF NOT EXISTS journey_events_journey_idx ON journey_events (journey_id, created_at);

-- ---- disputes (new minimal journey) ----
CREATE TABLE IF NOT EXISTS disputes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id  uuid NOT NULL REFERENCES transactions(id),
    reason          text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
    status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED')),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_open_tx_idx ON disputes (transaction_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS disputes_user_idx ON disputes (user_id, created_at DESC);
