<?php
/**
 * One-time (re-runnable) Elasticsearch setup for the SecBank dashboards, using ES_BANK_API_KEY:
 * ILM policy, index template + data stream logs-bank.business-default, lookup indices
 * (seeded from Postgres) and the bank-journey-health index. Additive only: existing indices,
 * documents and the tensai-* indices are never deleted or overwritten.
 *
 *   php bin/setup-elastic.php
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Es, BankExport};

if (!Es::env('ES_URL') || !Es::env('ES_BANK_API_KEY')) { fwrite(STDERR, "ES_URL and ES_BANK_API_KEY must be set (api/.env)\n"); exit(1); }
try {
    BankExport::setup();
    echo "[setup] done\n";
} catch (Throwable $e) {
    fwrite(STDERR, '[setup] FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}
