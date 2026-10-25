# Node → PHP backend migration + Elastic RUM — runbook

This documents the cutover from the Node/Express backend to the PHP (Slim 4)
backend, the addition of Elastic RUM to the frontend, and the removal of
OpenTelemetry. **The destructive server cutover (steps 4–6) is not performed
until explicitly confirmed.** The existing PostgreSQL data is preserved
throughout — no `DROP`, no destructive migration.

## What changed in the repo

- `api/` — new PHP backend (identical REST contract). See `api/README.md`.
- `frontend/src/apm.ts` + `main.tsx` — Elastic RUM (`@elastic/apm-rum`),
  service `tensai-secbank-web`. No OpenTelemetry in the frontend.
- OpenTelemetry removed from the go-forward stack: the PHP backend has none;
  the seeder (`api/bin/seed-test-data.php`) is OTEL-free. Observability is
  Elastic RUM (browser) + Elastic APM PHP agent (server `php.ini`).
- The Node backend (`backend/`) is **retained untouched** as the rollback
  target until the cutover is confirmed.

## Compatibility guarantees (validated locally)

- bcrypt hashes and HS256 JWTs are cross-compatible (same `JWT_SECRET`): a user
  created by Node logs into PHP and vice-versa; existing tokens stay valid.
- Migrations are the original idempotent files → running them against the live
  DB preserves every row.
- Full API smoke test green (auth, accounts, transactions, cards, loans,
  payees, transfers, recurring bills, autopay, statistics, rewards, chatbot,
  CSV statement). Scheduler validated (due item executes, ledger stays
  balanced). Seeder self-check green (ledger integrity preserved).

## Pre-cutover backup (do first, always)

```bash
# 1. Full database dump (the single source of truth for rollback).
pg_dump "$DATABASE_URL" -Fc -f /var/backups/tensai-$(date +%Y%m%d-%H%M%S).dump

# 2. Snapshot the current server deployment directory.
tar czf /var/backups/tensai-app-$(date +%Y%m%d-%H%M%S).tgz /var/www/tensai

# 3. Record the running Node process/service state (for rollback).
systemctl status tensai-node > /var/backups/tensai-node-state.txt 2>&1 || true
```

## Cutover (only after explicit confirmation)

1. Deploy `api/` to the server; `composer install --no-dev`; `cp .env` with the
   **existing** `DATABASE_URL` and `JWT_SECRET`.
2. `php bin/migrate.php` (idempotent — applies catalog seed, touches no data).
3. Build the frontend with RUM: `npm --workspace frontend run build`, deploy
   `frontend/dist`.
4. Configure Apache/php-fpm front controller (see `api/README.md`), start the
   PHP service, install the scheduler cron/timer, add the Elastic APM agent to
   `php.ini`.
5. Smoke-test against the live PHP backend (login existing user, dashboard,
   a transfer, statement download).
6. Stop the Node backend. Keep it installed (do not delete) until the PHP
   backend has run clean for an agreed soak period.

## Rollback

1. Stop the PHP service; restart the Node service (`systemctl start tensai-node`).
2. Point Apache back at the Node upstream (revert the vhost / proxy config).
3. Only if data was somehow affected (it should not be — PHP ran the same
   idempotent migrations): restore the dump:
   ```bash
   pg_restore --clean --if-exists -d "$DATABASE_URL" /var/backups/tensai-<ts>.dump
   ```

## Known environment notes

- Server PostgreSQL: native cluster on port 5433 (a Docker `postgres:16` also
  listens on 5432 via docker-proxy). The server `.env` uses **5433**.
- Azure NSG blocks inbound 80/443 (22 open). Confirm the reverse-proxy/exposure
  plan with the infra owner before relying on public HTTP.

---

# Upgrade 0007 — roles, transaction attempts, feedback, login locations, synthetic journeys

Additive release on top of the PHP backend. Server paths below match the live
host (`/var/www/tensai-secbank`, php8.1-fpm, Apache, native Postgres :5433 db `tensai`).

## What it adds
- `migrations/0007_*.sql` — `users.role` (CUSTOMER|ADMIN), `users.is_synthetic`,
  `login_events.session_id`, new tables `login_locations`, `transaction_attempts`,
  `transaction_feedback` (FKs, CHECK constraints, indexes). Backfills
  `is_synthetic` for `@tensai.test` / `@loadtest.tensai.test` users. No existing
  column or row is altered otherwise. Rollback SQL: `migrations/rollback/`.
- API: Customer/Admin sign-in (`loginAs`), `/api/admin/*` (role-enforced, audited),
  `POST /api/auth/location`, `POST /api/feedback`; every transfer / bill payment
  attempt recorded with outcome + failure category; bill payment now checks account
  ownership and balance (both previously missing).
- Frontend: Customer/Admin login, location-consent prompt, post-transaction
  feedback prompt, `/admin` console.
- Telemetry: same indices (`tensai-*`, `traces-apm*`) — see `kibana/README.md`.

## Required environment (api/.env)
| Variable | Value | Notes |
|---|---|---|
| `FAULT_INJECTION_ENABLED` | `true` only if you run the synthetic generator | affects synthetic users only |
| `TRANSFER_LIMIT_PER_TXN` | `500000` (default) | per P2P / external transfer |
| `SYNTHETIC_EMAIL_DOMAINS` | `tensai.test` (default) | covers `loadtest.tensai.test` |
| `USER_REF_SALT` | optional | default derives from `JWT_SECRET` |
Existing `DATABASE_URL`, `JWT_SECRET`, `ES_URL`, `ES_API_KEY` are unchanged.

## Deploy
```bash
cd /var/www/tensai-secbank
sudo php api/bin/traffic.php --stop                                   # pause synthetic traffic
sudo -u postgres pg_dump -p 5433 -Fc tensai -f /var/backups/tensai/pre-0007-$(date +%F-%H%M).dump
sudo git checkout -- frontend/tsconfig.node.tsbuildinfo frontend/vite.config.js   # build artefacts touched by the last build
sudo git pull origin main
sudo php api/bin/migrate.php                                          # expect: applied 0007_...
echo 'FAULT_INJECTION_ENABLED=true' | sudo tee -a api/.env            # only if running the generator
sudo env "PATH=$PATH" npm --workspace frontend run build
sudo systemctl restart php8.1-fpm && sudo apachectl configtest && sudo systemctl reload apache2
sudo ADMIN_PASSWORD='<12+ char secret>' php api/bin/create-admin.php --email=<staff email> --name="<Full Name>"
cd api && sudo flock /tmp/tensai-export.lock php bin/export-to-elastic.php   # one FULL export: backfills new fields
sudo cp ../deploy/tensai-traffic@.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo php bin/traffic.php --resume && sudo systemctl restart tensai-traffic@1 tensai-traffic@2 tensai-traffic@3
```
Kibana: import `kibana/tensai-panels-update.ndjson` (overwrite) — updates panels in
place and adds the Journeys dashboard without touching customised dashboards.

## Verify
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/admin/summary          # 401
sudo -u postgres psql -p 5433 tensai -c "SELECT is_synthetic, role, count(*) FROM users GROUP BY 1,2"
sudo -u postgres psql -p 5433 tensai -c "SELECT outcome, error_category, count(*) FROM transaction_attempts
  WHERE created_at > now() - interval '15 minutes' GROUP BY 1,2 ORDER BY 3 DESC"
journalctl -u tensai-traffic@1 -n 5 --no-pager                                       # dup_violations=0
tail -n 8 /var/log/tensai-export.log                                                  # docs > 0, no FAILED
```
Kibana Discover: `record_type : "failed_attempt"` (tensai-transactions),
`location_status : *` (tensai-login-events), `labels.session_id : *` (traces-apm*).
Full automated suite (creates test users — staging/local only):
`php api/tests/integration.php --base=http://127.0.0.1 --allow-writes`.

## Rollback
```bash
cd /var/www/tensai-secbank
sudo php api/bin/traffic.php --stop
sudo git checkout --detach 804f926      # previous release (undo: sudo git checkout main); 0007 schema is additive, old code ignores it
sudo env "PATH=$PATH" npm --workspace frontend run build && sudo systemctl restart php8.1-fpm
# Only if the schema itself must go (destroys 0007 data only; take a dump first):
sudo -u postgres psql -p 5433 tensai -v ON_ERROR_STOP=1 -f api/migrations/rollback/0007_roles_attempts_feedback_locations.down.sql
```
Kibana: `git show 804f926:kibana/tensai-panels-update.ndjson > /tmp/panels-prev.ndjson`,
import with overwrite, delete the Journeys dashboard; optionally remove failed-attempt
docs: `POST tensai-transactions/_delete_by_query {"query":{"term":{"record_type":"failed_attempt"}}}`.
