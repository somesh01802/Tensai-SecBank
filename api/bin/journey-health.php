<?php
/**
 * Journey Health Index job: recomputes bank-journey-health for the last N minutes (default 5)
 * from logs-bank.business-default. Idempotent (one _id per journey/minute/synthetic flag).
 * Cron every minute, after the exporter:
 *   * * * * * cd /var/www/tensai-secbank/api && php bin/journey-health.php >> var/health.log 2>&1
 *   php bin/journey-health.php --minutes=1440     backfill a day
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Es, BankExport};

if (!Es::env('ES_URL') || !Es::env('ES_BANK_API_KEY')) { fwrite(STDERR, "ES_URL and ES_BANK_API_KEY must be set (api/.env)\n"); exit(1); }
$m = max(1, (int) (getopt('', ['minutes::'])['minutes'] ?? 5));
try {
    exit(BankExport::health($m) ? 1 : 0);
} catch (Throwable $e) {
    fwrite(STDERR, '[health] FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}
