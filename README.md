# Tensai SecBank

Full-stack banking app with a PostgreSQL-backed double-entry ledger, idempotent
transfers, beneficiaries, profile settings, and an ICICI-style public marketing site.

- **backend/** — Node.js + Express + Drizzle ORM + PostgreSQL (via PGlite in dev)
- **frontend/** — Vite + React 18 + TypeScript + Tailwind + React Query + Recharts

## Quick start

```bash
npm install
npm run dev
```

- Public landing site: <http://localhost:5173/>
- Auth (register/login): <http://localhost:5173/register>, <http://localhost:5173/login>
- Banking app (after login): <http://localhost:5173/app>
- API: <http://localhost:3000>

`npm run dev` starts:
- an embedded PostgreSQL (PGlite) in `backend/.pg-data/` — no PostgreSQL install required
- the Express API on `:3000`
- the Vite dev server on `:5173`

Data persists across restarts. Delete `backend/.pg-data/` to start fresh.

### Seeded system user (for admin seeding of funds)

- Email: `system@tensai.local`
- Password: `system-secret-change-me`

Log in as this user then `POST /api/transactions/system/initial-funds` to top up any
account (useful for demoing the transfer flow).

## Production PostgreSQL

Set `DATABASE_URL` in `backend/.env` to point at a real Postgres:

```
DATABASE_URL=postgres://user:pass@host:5432/tensai_secbank
```

Then run `npm --workspace backend run start`. Migrations at `backend/src/db/migrations/`
run automatically on boot (idempotent — safe to rerun).

## Schema

```
users          (id, email, name, password_hash, is_system_user)
accounts       (id, user_id → users, currency, status)
transactions   (id, from_account_id → accounts, to_account_id → accounts,
                amount NUMERIC, status, idempotency_key UNIQUE, description)
ledger_entries (id, account_id, transaction_id, type DEBIT|CREDIT, amount)
                — application-immutable; one DEBIT + one CREDIT per transaction
beneficiaries  (id, user_id → users, to_account_id → accounts, nickname)
                — UNIQUE (user_id, to_account_id)
revoked_tokens (token PRIMARY KEY, expires_at)  — JWTs invalidated on logout
```

Balance is a live aggregate:

```sql
SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END)
```

## Money movement — how transfers work

Every `POST /api/transactions` runs inside a single **PostgreSQL transaction**:

1. Check idempotency key — replay outcome if the key already exists.
2. Insert the `transactions` row (PENDING).
3. Insert the sender's `DEBIT` ledger entry.
4. Aggregate the sender's balance *inside* the transaction. If it went below 0, throw
   and let PostgreSQL roll everything back.
5. Insert the recipient's `CREDIT` ledger entry.
6. Update the transaction row to COMPLETED.

Either all six commit, or none do. Insufficient balance is impossible even under
concurrent transfers: the DEBIT+balance-check happens in the same transaction, so a
second concurrent transfer either sees the first's DEBIT and correctly rejects, or is
serialised behind it.

## API

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | – | `{ name, email, password }` |
| POST | `/api/auth/login` | – | `{ email, password }` |
| POST | `/api/auth/logout` | ✅ | Revokes JWT |
| GET | `/api/auth/me` | ✅ | Session restore |
| GET | `/api/accounts` | ✅ | Includes computed `balance` per account |
| POST | `/api/accounts` | ✅ | Opens a new USD ACTIVE account |
| GET | `/api/accounts/balance/:id` | ✅ | Live balance |
| GET | `/api/accounts/:id/ledger` | ✅ | Ledger entries for charts |
| GET | `/api/transactions` | ✅ | Annotated with `direction: IN\|OUT` |
| POST | `/api/transactions` | ✅ | `{ fromAccount, toAccount, amount, idempotencyKey, description? }` |
| POST | `/api/transactions/system/initial-funds` | ✅ system user | Seed money into an account |
| GET | `/api/beneficiaries` | ✅ | Saved payees |
| POST | `/api/beneficiaries` | ✅ | `{ nickname, toAccountId }` |
| DELETE | `/api/beneficiaries/:id` | ✅ | |
| GET | `/api/profile` | ✅ | |
| PATCH | `/api/profile` | ✅ | `{ name?, email? }` |
| POST | `/api/profile/change-password` | ✅ | `{ currentPassword, newPassword }` |

## Frontend routes

| Path | Purpose |
|---|---|
| `/` | Public marketing site (mega menu, hero carousel, product tiles, footer) |
| `/login`, `/register` | Auth |
| `/app` | Banking dashboard |
| `/app/accounts` | Manage accounts |
| `/app/transfer` | Send money (via beneficiary or account ID) |
| `/app/beneficiaries` | Saved payees |
| `/app/transactions` | Full history with filters + search |
| `/app/analytics` | Balance over time, in/out, status breakdown |
| `/app/settings` | Profile + change password |

## Verified

Run the smoke test to confirm the full stack is healthy:

```bash
node <scratchpad>/smoke.mjs
```

Checks: health, register (+dup rejection), account creation, system seed, beneficiary
CRUD, transfer with ACID commit, idempotency replay, insufficient-balance rejection,
transaction listing with direction, profile edit, change password + relogin, logout
with token revocation. 13/13 green.

## v3 (Sep 2026) — AI assistant, splash, and OpenTelemetry

**Chatbot (`POST /api/chatbot/message`).** Server-owned. Uses Anthropic Claude
when `ANTHROPIC_API_KEY` is set; otherwise falls back to a deterministic
rule-based responder over the same sanitized context. Never sees MPINs,
CVVs, full card numbers, passwords, or another user's data.

**Post-login splash.** 6.5-second premium transition with the TSB mark before
the dashboard opens. Only fires once per authentication event (auth store's
`justAuthed` flag).

**OpenTelemetry / Elastic APM.** The existing NodeSDK exports traces, business
metrics, and redacted application console logs over OTLP/HTTP. Set
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and
`OTEL_RESOURCE_ATTRIBUTES` in `backend/.env`; keep the API key out of source
control and frontend configuration. Resource identity includes the service
name, namespace, version, environment, application, and component. Business
metrics cover auth attempts/failures, transfer count/amount, bills paid, loans,
cards, accounts, statement downloads, chatbot requests/latency, business errors,
and scheduler runs. The frontend's API requests (from both public and signed-in
flows) are traced at the backend; browser navigation itself is not instrumented.
Health at `GET /telemetry/health`.

### Deploying updates to the Linux server

On the server (assuming layout from the earlier deploy guide — `/var/www/tensai/app`):

```bash
# 1. Pull latest
sudo -u tensai git -C /var/www/tensai/app pull

# 2. Backend deps + rebuild frontend
sudo -u tensai npm --prefix /var/www/tensai/app/backend  install --omit=dev
sudo -u tensai npm --prefix /var/www/tensai/app/frontend install
sudo -u tensai npm --prefix /var/www/tensai/app/frontend run build

# 3. Migrations run automatically at boot — just restart the API
sudo systemctl restart tensai-api

# 4. Apache serves the freshly built dist/ — reload to pick up new assets
sudo systemctl reload apache2

# 5. Verify
curl -s http://127.0.0.1:$(grep '^PORT=' /var/www/tensai/app/backend/.env | cut -d= -f2)/health
curl -s http://127.0.0.1:$(grep '^PORT=' /var/www/tensai/app/backend/.env | cut -d= -f2)/telemetry/health
sudo journalctl -u tensai-api -n 30 --no-pager
```

### Wiring up telemetry to an ELK / OTEL Collector

Set the Elastic OTLP endpoint and API-key header in `backend/.env`:

```
OTEL_SERVICE_NAME=tensai-secbank-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://tensai.ingest.us-east-1.aws.elastic-cloud.com:443
OTEL_EXPORTER_OTLP_HEADERS=Authorization=ApiKey <API_KEY>
OTEL_RESOURCE_ATTRIBUTES=service.namespace=tensai,service.version=3.0.0,deployment.environment.name=development,banking.app=tensai-secbank,banking.component=backend
```

The exporters send to `/v1/traces`, `/v1/metrics`, and `/v1/logs` under that base
endpoint. Never commit the real API key; use the ignored local `.env`, a CI
secret, or your deployment secret manager. Public landing-page and authenticated
API requests share the backend service identity. Browser-side RUM is intentionally
not enabled because the OTLP API key must never be exposed to browsers.

After configuring the header, verify all three OTLP signal endpoints with:

```bash
npm --workspace backend run verify:otel
```

The verifier sends a minimal trace, metric, and log canary and prints only HTTP
status codes. HTTP 200 indicates that Elastic accepted the OTLP payloads. In
Kibana, open **Observability → APM → Services**, select `tensai-secbank-api`,
and check the matching environment. For the canary span, search for
`tensai.secbank.apm.validation`; metrics and logs use the same service resource.

Disable telemetry entirely with `TELEMETRY_ENABLED=false`.

### Wiring up the AI assistant

Set:

```
ANTHROPIC_API_KEY=sk-ant-xxxx
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

Without a key, the chatbot still works via rule-based answers.

## Synthetic test data (5,000 users) + telemetry

`backend/scripts/seed-test-data.js` seeds synthetic users with realistic banking
data and a success/failure transaction mix. Idempotent (rerun skips existing),
tagged `[SYNTHETIC]`, ledger-safe (failed transactions write no ledger entries),
and it emits OpenTelemetry for a sampled fraction of transactions.

```bash
cd backend
# Default: 5000 users, 8 tx each. Needs DATABASE_URL set (prod Postgres or pglite://).
npm run seed:test

# Quick validation run:
SEED_USERS=20 npm run seed:test

# Tuning (all optional):
SEED_USERS=5000 SEED_TX_PER_USER=8 SEED_OTEL_SAMPLE=0.05 SEED_EMIT_OTEL=true npm run seed:test
```

Config env: `SEED_USERS`, `SEED_TX_PER_USER`, `SEED_PREFIX`, `SEED_BCRYPT_ROUNDS`
(10 = app default), `SEED_EMIT_OTEL`, `SEED_OTEL_SAMPLE`, `SEED_MANIFEST`.

**Credential manifest** (gitignored, never committed): written to
`backend/scripts/out/test-credentials.json` as
`[{ userId, email, mobileNumber, password, mpin }]`. Each synthetic user logs in
through the real app with **email + password** or **mobile + MPIN**. The file is
written `0600`; treat it as a secret and delete it when done:
`rm backend/scripts/out/test-credentials.json`. ~5000 users take several minutes
(bcrypt). Re-running after deleting the manifest cannot recover plaintext for
already-seeded users — keep the file or reseed into a fresh DB.

Failure scenarios covered (as `banking.error.category` on spans and the
transaction `category` column): CORE_TIMEOUT, API_FAILURE, FRAUD_TIMEOUT,
DB_DEADLOCK, NETWORK_LATENCY, OTP_DELAY, DISTRIBUTED_INCONSISTENCY,
PROCESSOR_OUTAGE, INFRA_FAILURE, INSUFFICIENT_FUNDS, INVALID_ACCOUNT,
LIMIT_EXCEEDED, EXPIRED_CARD.

### Transaction telemetry

Every live transfer (`POST /api/transactions`) and sampled synthetic
transactions emit a `bank.transaction` span + metrics + a structured log via
`telemetry.recordTransaction(...)` with: `banking.transaction.id`,
`banking.user.id`, `banking.operation`, `banking.account.{from,to}_last4`,
`banking.amount`, `banking.currency`, `banking.outcome` (SUCCESS|FAILURE),
`banking.transaction.status`, `banking.error.category`, `banking.failure.reason`,
`banking.synthetic`, `http.route`, `service.name`, `deployment.environment`,
`duration.ms`, plus trace/span IDs. Secrets (password, MPIN, CVV, full card
number, tokens) are never attached.

### Kibana / Elastic queries

Traces (APM → Traces, or Discover on `traces-apm*`):

```
# All synthetic transactions
labels.banking.synthetic: true

# Failures by category
labels.banking.outcome: "FAILURE" and labels.banking.error.category: "DB_DEADLOCK"

# Large successful transfers
labels.banking.outcome: "SUCCESS" and labels.banking.amount > 1000
```

Lens / dashboard panels:
- **Transaction volume**: count of `span.name: "bank.transaction"` over time, split by `labels.banking.outcome`.
- **Success vs failure rate**: terms on `labels.banking.outcome`.
- **Failure categories**: top terms of `labels.banking.error.category` (filter outcome=FAILURE).
- **Latency percentiles**: p50/p95/p99 of `labels.duration.ms` (or `transaction.duration.us`), split by `labels.banking.operation`.
- **Error rate per service**: `labels.banking.outcome: FAILURE` count ÷ total, by `service.name`.
- **Per-operation performance**: avg `duration.ms` by `labels.banking.operation`.

Business metrics (Metrics / Lens on OTLP metrics): `banking.transfers.count`,
`banking.transfers.amount`, `banking.errors.count`, `banking.auth.attempts`,
`banking.auth.failures`.
