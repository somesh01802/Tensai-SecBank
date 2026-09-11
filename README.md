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
| POST | `/api/accounts` | ✅ | Opens a new INR ACTIVE account |
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

**OpenTelemetry.** Traces + metrics via OTLP HTTP. Point at any OTEL-compatible
collector by setting `OTEL_EXPORTER_OTLP_ENDPOINT`. Business metrics recorded:
auth attempts/failures, transfers count/amount, bills paid, loans applied/closed,
cards issued, accounts opened/closed, statement downloads, chatbot requests +
latency, business errors, scheduler runs. Health at `GET /telemetry/health`.

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

Set the OTLP endpoint (and optional auth headers) in `backend/.env`:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318
OTEL_EXPORTER_OTLP_HEADERS=api-key=xxx
```

Any OTEL-compatible collector will work (OpenTelemetry Collector, Grafana Agent,
Elastic APM Server, Honeycomb, Datadog OTEL endpoint). Traces land in your APM
UI; metrics land in the metrics backend of your choice; both feed dashboards in
Kibana / Grafana / Canvas.

Disable telemetry entirely with `TELEMETRY_ENABLED=false`.

### Wiring up the AI assistant

Set:

```
ANTHROPIC_API_KEY=sk-ant-xxxx
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

Without a key, the chatbot still works via rule-based answers.
