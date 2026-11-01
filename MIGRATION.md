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

---

# Upgrade 0008: SecBank dashboards (journey telemetry, Elasticsearch pipeline, simulator, D0-D9, Canvas)

Additive release on top of 0007 (commits `fe0ce92` .. this one). No frontend change (no rebuild), no change to
existing tables' rows, no change to the existing `tensai-*` indices or dashboards. If 0007 is not deployed yet,
`migrate.php` applies 0007 and 0008 in order; also run the 0007 steps (create-admin) above.

## What it adds
- `migrations/0008_bank_journeys.sql`: lookup tables (`bank_regions`, `bank_branches`, `bank_journeys`,
  `bank_journey_steps`), `users.segment` / `users.home_branch_id` (filled only where NULL, plus a trigger for new
  users), `journey_events`, `disputes`, `CARD` attempt kind. Rollback: `migrations/rollback/0008_bank_journeys.down.sql`.
- API: journey step events (`Journey` middleware), `POST /api/journey/step`, `POST /api/cards/{id}/pay`,
  `GET|POST /api/disputes`.
- Elasticsearch (key `ES_BANK_API_KEY`, never the tensai-* key): data streams `logs-bank.business-default`,
  `logs-bank.app-default`, `logs-bank.synthetics-default`, `metrics-bank.platform-default` (ILM `bank-30d`: 30 days);
  lookup indices `bank-branches`, `bank-journeys`, `bank-journey-steps`, `bank-customers`; `bank-journey-health`
  (90 days), `bank-problems`, `bank-problem-rank`, `bank-risks`, `bank-ai-scores`, `bank-demo-ledger` (ground truth).
- Jobs: exporter also ships journey events + customers; `bin/journey-health.php` every minute (health index,
  problem detection, risks); `bin/simulate.php` (simulated bank, `deploy/tensai-simulator.service`).
- Kibana: `kibana/secbank-dashboards.ndjson` (D0-D9, Canvas `SecBank wallboard`), new ids only. See `kibana/README.md`.

## Required environment (api/.env)
| Variable | Value |
|---|---|
| `ES_BANK_API_KEY` | key `tensai-bank-pipeline-v2` (logs-bank.\*, metrics-bank.\*, bank-\* write; tensai-\* read). Already set. |
| `APM_SERVER_URL` / `APM_SECRET_TOKEN` | not needed: the simulator reads the PHP agent's `elastic_apm.*` from the fpm config |

## Deploy
```bash
cd /var/www/tensai-secbank
sudo php api/bin/traffic.php --stop                                        # pause the real-app load generator
sudo -u postgres pg_dump -p 5433 -Fc tensai -f /var/backups/tensai/pre-0008-$(date +%F-%H%M).dump
ls -lh /var/backups/tensai/ | tail -2                                      # the dump must exist and be > 0 bytes
sudo git status --short                                                    # expect no local edits besides build artefacts
sudo git checkout -- frontend/tsconfig.node.tsbuildinfo frontend/vite.config.js 2>/dev/null
sudo git pull origin main
sudo php api/bin/migrate.php                                               # applies 0008 (re-running is safe)
sudo systemctl restart php8.1-fpm && sudo apachectl configtest && sudo systemctl reload apache2
sudo install -d -o www-data -g www-data api/var                            # simulator fault switches live here

cd api
sudo -u www-data php bin/setup-elastic.php                                 # ILM, templates, data streams, lookups, indices
sudo flock /tmp/tensai-export.lock php bin/export-to-elastic.php          # one FULL export: journey events + customers
sudo php bin/traffic.php --resume && sudo systemctl restart 'tensai-traffic@*'

# Health index + problem detection every minute (after the exporter's minute).
echo '* * * * * www-data cd /var/www/tensai-secbank/api && sleep 20 && flock -n /tmp/tensai-health.lock php bin/journey-health.php >> /var/log/tensai-health.log 2>&1' \
  | sudo tee /etc/cron.d/tensai-secbank-health
sudo touch /var/log/tensai-health.log && sudo chown www-data /var/log/tensai-health.log

# Simulated bank, live 24/7 at 10 % of the demo volume.
sudo cp ../deploy/tensai-simulator.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now tensai-simulator
sudo -u www-data php bin/simulate.php --ai-history=60                      # D9 history (simulated, labelled)
```
Optional, a week of quiet baseline so ML jobs have history (about 30 minutes to send; run once, before any demo):
`sudo -u www-data php -d memory_limit=1G bin/simulate.php --backfill=10080 --scale=0.1 --run=none --seed=7`

Kibana: **Stack Management → Saved Objects → Import** `kibana/secbank-dashboards.ndjson` ("Check for existing
objects", overwrite). Only `secbank-*` objects and the `SecBank wallboard` workpad are created.

Kibana-side objects (10 journey SLOs with burn-rate rules, problem / payments-svc rules, 4 ML jobs). Create the key
in Kibana Dev Tools as the deployment's `elastic` user (`POST /_security/api_key {"name": "secbank-kibana-setup"}`),
put `KIBANA_URL` and `KIBANA_API_KEY=<encoded>` in `api/.env` (never in chat or git), then:
```bash
node --version                                                             # needs 18 or newer
cd /var/www/tensai-secbank && sudo node kibana/setup-kibana.mjs          # re-runnable; prints ok / FAIL per object
sudo node kibana/setup-kibana.mjs --forecast                               # a few hours later: 1-day memory forecast
```
Removal of exactly these objects: `sudo node kibana/setup-kibana.mjs --remove`.

## Demo runs
- Live: `sudo -u www-data php bin/simulate.php --start=S1` (S1..S10) and `--stop=S1`; `--list` shows what runs.
- Frozen four-problem hour (the spec's 17:46 screen), simulator paused:
```bash
sudo systemctl stop tensai-simulator
sudo -u www-data php -d memory_limit=1G bin/simulate.php --backfill=60 --run=four --seed=$(date +%s)
# then run the exact command it prints, e.g.:
sudo -u www-data php bin/journey-health.php --minutes=65 --replay --at=<epoch it printed>
```
  Set the dashboards' time picker to that hour; Canvas: set the header time filter (or rebuild with
  `SECBANK_CANVAS_TIME`). A new `--seed` per rehearsal keeps runs separate. Restart the live simulator afterwards.

## Verify
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1/api/journey/step     # 401 (route exists, needs auth)
sudo -u postgres psql -p 5433 tensai -c "SELECT segment, count(*) FROM users GROUP BY 1"   # retail/premier/sme, no NULL
sudo -u postgres psql -p 5433 tensai -c "SELECT journey, status, count(*) FROM journey_events
  WHERE created_at > now() - interval '15 minutes' GROUP BY 1,2 ORDER BY 3 DESC"
tail -n 3 /var/log/tensai-health.log                       # [health] ... docs, [problems] open N
journalctl -u tensai-simulator -n 5 --no-pager             # APM sink: https://... (Bearer auth)
set -a; . /var/www/tensai-secbank/api/.env; set +a
curl -s -H "Authorization: ApiKey $ES_BANK_API_KEY" "$ES_URL/_cat/indices/*bank*?v&h=index,docs.count,store.size"
```
In Kibana open `SecBank D0 · Bank Pulse` (last 60 minutes): the scorecard lists ten journeys; D5's service table lists
the simulated services (needs the simulator's APM sink). Query check from a workstation with the key in the env:
`ES_BANK_API_KEY=... node kibana/build-secbank.mjs --check $ES_URL` (prints any failing panel).

## Rollback
```bash
cd /var/www/tensai-secbank
sudo systemctl disable --now tensai-simulator && sudo rm /etc/cron.d/tensai-secbank-health
sudo git checkout --detach d54b693      # 0007 release (undo: sudo git checkout main); the 0008 schema is additive
sudo systemctl restart php8.1-fpm
# Only if the schema itself must go (destroys 0008 data only; take a dump first):
sudo -u postgres psql -p 5433 tensai -v ON_ERROR_STOP=1 -f api/migrations/rollback/0008_bank_journeys.down.sql
```
Elasticsearch (only if the SecBank data must go; deletes simulated data and the journey copy, nothing in `tensai-*`):
`DELETE _data_stream/logs-bank.*,metrics-bank.*` then `DELETE bank-*` and `DELETE _index_template/logs-bank.*,metrics-bank.*`.
Kibana: `sudo node kibana/setup-kibana.mjs --remove` (SLOs, rules, ML jobs), then Saved Objects → search `secbank` →
select all → Delete; Canvas → delete `SecBank wallboard`.
