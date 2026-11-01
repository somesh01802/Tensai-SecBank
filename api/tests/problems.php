<?php
// Problem detection end to end on a LOCAL Elasticsearch: simulate a scenario hour, replay detection, check
// what the wallboard would show. DELETES the bank data streams/indices it rebuilds, so it refuses any
// non-local ES_URL and needs --allow-reset.
//   ES_URL=http://127.0.0.1:9200 ES_BANK_API_KEY=x php tests/problems.php --allow-reset
require __DIR__ . '/../src/bootstrap.php';
use Tensai\{Es, Problems};

if (!preg_match('#^https?://(127\.0\.0\.1|localhost)(:\d+)?/?$#', (string) Es::env('ES_URL'))) exit("refusing: ES_URL must be a local Elasticsearch\n");
if (!isset(getopt('', ['allow-reset'])['allow-reset'])) exit("refusing without --allow-reset (rebuilds the bank data streams)\n");
$pass = $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void {
    global $pass, $fail; $ok ? $pass++ : $fail++;
    echo ($ok ? '  PASS ' : '  FAIL ') . $name . ($ok || !$detail ? '' : "  -> $detail") . "\n";
}
function sh(string $script, string $args = ''): string {
    return (string) shell_exec(escapeshellarg(PHP_BINARY) . ' -d memory_limit=1G ' . escapeshellarg(__DIR__ . "/../bin/$script") . " $args 2>&1");
}
/** Fresh bank data, one scenario run, detection replayed at the freeze time. */
function scenario(string $run, float $scale): void {
    foreach (['_data_stream/logs-bank.business-default', '_data_stream/logs-bank.app-default', '_data_stream/logs-bank.synthetics-default',
        '_data_stream/metrics-bank.platform-default', 'bank-demo-ledger', 'bank-journey-health', Problems::INDEX, Problems::RANK, Problems::RISKS] as $x)
        Es::req('DELETE', "/$x", '', 'ES_BANK_API_KEY');
    sh('setup-elastic.php');
    preg_match('/--at=(\d+)/', sh('simulate.php', "--backfill=60 --run=$run --no-apm --scale=$scale"), $m);
    sh('journey-health.php', '--minutes=65 --replay --at=' . ($m[1] ?? time()));
    Es::req('POST', '/bank-*/_refresh', '', 'ES_BANK_API_KEY');
}

echo "[four-problem run]\n";
scenario('four', 1.0);
$open = Es::esql('FROM ' . Problems::INDEX . ' | WHERE problem.status == "open" | KEEP problem.key, problem.severity, problem.owner, problem.started_at, problem.detected_at | LIMIT 50');
$keys = array_column($open, 'problem.severity', 'problem.key');
check('exactly the four injected problems are open (no false positives)', count($open) === 4, json_encode($keys));
check('bill pay critical, autopay major, Northeast OTP major, BR-017 minor', ($keys['journey:bill_pay'] ?? '') === 'critical'
    && ($keys['volume:autopay_run'] ?? '') === 'major' && ($keys['region:Northeast:otp_expired'] ?? '') === 'major' && ($keys['branch:BR-017'] ?? '') === 'minor');
$led = array_column(Es::esql('FROM bank-demo-ledger | KEEP scenario.id, started_at'), 'started_at', 'scenario.id');
$det = array_column($open, 'problem.detected_at', 'problem.key');
$lag = fn($k, $s) => isset($det[$k], $led[$s]) ? (strtotime($det[$k]) - strtotime($led[$s])) / 60 : null;
$lags = ['S1' => $lag('journey:bill_pay', 'S1'), 'S9' => $lag('volume:autopay_run', 'S9'), 'S3' => $lag('region:Northeast:otp_expired', 'S3'), 'S10' => $lag('branch:BR-017', 'S10')];
check('each detected 1 to 10 minutes after injection (from signals, not the ledger)', !array_filter($lags, fn($l) => $l === null || $l < 1 || $l > 10), json_encode($lags));
$rank = Es::esql('FROM ' . Problems::RANK . ' | WHERE kind == "problem" | SORT slot | KEEP slot, problem.key');
check('wallboard slots ranked severity then value at risk', array_column($rank, 'problem.key') === ['journey:bill_pay', 'volume:autopay_run', 'region:Northeast:otp_expired', 'branch:BR-017'], json_encode($rank));
$own = array_column($open, 'problem.owner', 'problem.key');
check('owners from evidence: Payments, Payments, Identity, Branch network', $own == ['journey:bill_pay' => 'Payments on-call',
    'volume:autopay_run' => 'Payments on-call', 'region:Northeast:otp_expired' => 'Identity on-call', 'branch:BR-017' => 'Branch network team'], json_encode($own));

echo "[quiet hour]\n";
scenario('none', 1.0);
$n = Es::esql('FROM ' . Problems::INDEX . ' | STATS n = COUNT(*)')[0]['n'] ?? -1;
check('no problems detected in a fault-free hour', $n === 0, (string) $n);
$slots = Es::esql('FROM ' . Problems::RANK . ' | WHERE slot > 0 | STATS n = COUNT(*) BY kind');
check('wallboard slots are empty, never missing', ($slots[0]['kind'] ?? '') === 'none' && ($slots[0]['n'] ?? 0) === 4, json_encode($slots));

echo "[S7 certificate, S8 memory]\n";
scenario('S7', 0.2);
$r = Es::esql('FROM ' . Problems::RISKS . ' | WHERE risk.status == "open" | KEEP risk.type, risk.days_left');
check('S7: certificate risk ~7 days', count($r) === 1 && $r[0]['risk.type'] === 'certificate' && abs($r[0]['risk.days_left'] - 7) < 0.1, json_encode($r));
$slot = Es::esql('FROM ' . Problems::RANK . ' | WHERE slot == 1 | KEEP kind');
check('free slot shows the next predicted risk', ($slot[0]['kind'] ?? '') === 'risk');
scenario('S8', 0.2);
$r = Es::esql('FROM ' . Problems::RISKS . ' | WHERE risk.status == "open" | KEEP risk.type, risk.days_left, service.name');
check('S8: notify-svc memory forecast to hit its limit in 4-7 h', count($r) === 1 && $r[0]['service.name'] === 'notify-svc'
    && $r[0]['risk.days_left'] * 24 > 4 && $r[0]['risk.days_left'] * 24 < 7, json_encode($r));

[$slope, $r2] = Problems::fit([0 => 1.0, 60 => 2.0, 120 => 3.0]);
check('linear fit: slope and r^2 on an exact line', abs($slope - 1 / 60) < 1e-9 && abs($r2 - 1) < 1e-9);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
