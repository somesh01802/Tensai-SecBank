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
