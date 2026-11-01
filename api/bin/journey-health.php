<?php
/**
 * Every minute, after the exporter: Journey Health Index (bank-journey-health) for the last N minutes
 * (default 5, idempotent _ids), then problem detection (bank-problems, bank-problem-rank, bank-risks).
 *   * * * * * cd /var/www/tensai-secbank/api && php bin/journey-health.php >> var/health.log 2>&1
 *   php bin/journey-health.php --minutes=65 --replay    after a simulator backfill: health for the window and
 *                                                       problem detection replayed minute by minute, so detection
 *                                                       times are where a per-minute rule would have fired.
 * Only use --replay on a window the detector has not processed yet (e.g. right after a backfill), otherwise
 * problems already closed can be opened again.
 *   --at=<epoch>   evaluate as of that time instead of now: a frozen demo (backfill with no live simulator after it).
 *                  bin/simulate.php --backfill prints the exact command. Without it, minutes after the data ends
 *                  look like an outage (every branch silent, autopay stopped).
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Es, BankExport, Problems};

if (!Es::env('ES_URL') || !Es::env('ES_BANK_API_KEY')) { fwrite(STDERR, "ES_URL and ES_BANK_API_KEY must be set (api/.env)\n"); exit(1); }
$o = getopt('', ['minutes::', 'replay', 'at::']);
$m = max(1, (int) ($o['minutes'] ?? 5));
$now = isset($o['at']) ? (int) $o['at'] : time();
try {
    $f = BankExport::health($m, $now);
    Es::req('POST', '/' . BankExport::STREAM . '/_refresh', '', 'ES_BANK_API_KEY');
    $f += Problems::run($now, isset($o['replay']) ? $now - $m * 60 : 0);
    exit($f ? 1 : 0);
} catch (Throwable $e) {
    fwrite(STDERR, '[health] FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}
