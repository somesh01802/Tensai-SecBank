# Tensai SecBank — PHP API

A drop-in PHP (Slim 4 + PDO/pgsql) reimplementation of the original Node/Express
backend. It preserves the **exact REST contract**, the **PostgreSQL schema and
data**, authentication (JWT + bcrypt), and every feature (accounts, cards,
loans, bills, transfers, payees, investments + AutoPay, recurring bills,
scheduled transfers, statistics, rewards, notifications, chatbot).

OpenTelemetry has been removed. Observability is now **Elastic**: the browser
uses Elastic RUM (frontend), and the PHP process uses the Elastic APM PHP agent
(configured in `php.ini`, below — not committed).

## Why it's compatible with existing data

- **Passwords/MPINs**: `password_hash`/`password_verify` (bcrypt, cost 10) read
  the existing bcryptjs hashes unchanged.
- **JWT**: hand-rolled HS256 with the same `{userId, iat, exp}` claims and the
  same `JWT_SECRET` → tokens issued by the Node app stay valid and vice-versa.
- **Schema**: `migrations/*.sql` are the original files, all `IF NOT EXISTS` /
  `ON CONFLICT`, so running them against the live DB is a no-op that preserves
  every row. `0005_catalog_seed.sql` seeds loan/card products + 100 reward tasks
  idempotently.

## Requirements

- PHP 8.1+ with `pdo_pgsql`, `curl`, `mbstring` extensions
- Composer
- PostgreSQL (the existing cluster/database)

## Setup

```bash
cd api
composer install
cp .env.example .env         # then edit: DATABASE_URL + JWT_SECRET must match the Node app
php bin/migrate.php          # idempotent; applies schema + catalog seed
```

## Run

Development:

```bash
php -S 127.0.0.1:8090 -t public public/index.php
```

> Note: `php -S` returns 404 for `/api/transactions/statement.csv` because its
> built-in server treats dotted paths as static-file requests. This is a
> dev-server quirk only — under Apache/php-fpm (below) the front controller
> handles it correctly.

Production (Apache + php-fpm, front controller):

```apache
# Serve the built frontend and reverse-proxy the API to php-fpm.
DocumentRoot /var/www/tensai/frontend/dist

# API: route every /api request through the PHP front controller.
Alias /api /var/www/tensai/api/public
<Directory /var/www/tensai/api/public>
    Require all granted
    FallbackResource /api/index.php     # front controller: fixes statement.csv etc.
    CGIPassAuth On                      # pass "Authorization: Bearer" to php-fpm (dropped by default)
</Directory>

# SPA fallback for client-side routes.
<Directory /var/www/tensai/frontend/dist>
    Require all granted
    FallbackResource /index.html
</Directory>
```

(Equivalently, nginx: `location /api { try_files $uri /api/index.php$is_args$args; }`.)

## Scheduler

Processes due investment AutoPay, recurring bills, and scheduled transfers.
Replaces the Node `setInterval` scheduler.

- One tick (cron, every minute):
  ```cron
  * * * * * cd /var/www/tensai/api && /usr/bin/php bin/scheduler.php >> /var/log/tensai-scheduler.log 2>&1
  ```
- Or a long-running loop (systemd service): `php bin/scheduler.php --loop`

## Synthetic seeder (optional)

```bash
SEED_USERS=20 php bin/seed-test-data.php     # quick validation
php bin/seed-test-data.php                    # default 5000 users
```

Writes a **gitignored** credential manifest to `scripts/out/test-credentials.json`.
No OpenTelemetry. Runs a ledger-integrity self-check (no FAILED-with-ledger,
no unbalanced transfers, no negative balances).

## Elastic APM PHP agent (php.ini)

Not committed (contains the secret token). Add to the server's `php.ini`:

```ini
extension=elastic_apm.so
elastic_apm.service_name=tensai-secbank-api
elastic_apm.secret_token=<token>
elastic_apm.server_url=https://<id>.apm.<region>.aws.cloud.es.io:443
elastic_apm.environment=production
```
