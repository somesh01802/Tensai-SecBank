<?php
// Simulator self-check (no Elasticsearch needed; reads the 0008 catalogues from Postgres).
//   php tests/simulator.php
require __DIR__ . '/../src/bootstrap.php';
use Tensai\{Db, Simulator, BankExport};

$pass = $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void {
    global $pass, $fail; $ok ? $pass++ : $fail++;
    echo ($ok ? '  PASS ' : '  FAIL ') . $name . ($ok || !$detail ? '' : "  -> $detail") . "\n";
}

$sim = new Simulator(7, 1.0, 5000);
$t0 = 1_800_000_000 - 1_800_000_000 % 60;   // fixed minute
$a = $sim->minute($t0);
$b = $sim->minute($t0);
check('same (seed, minute) -> identical rows and _ids (re-runs are no-ops)', json_encode($a) === json_encode($b));
$ids = array_filter(array_column($a, 1));
check('_ids unique within a minute', count($ids) === count(array_unique($ids)));
check('another seed -> different _ids', !array_intersect($ids, array_filter(array_column((new Simulator(8, 1.0, 5000))->minute($t0), 1))));

$refs = array_column($sim->customers(), 0);
$real = array_map(fn($u) => BankExport::customerRef($u['id']), Db::all('SELECT id FROM users'));
check('customer refs unique, C-XXXXXX, none equal to a real customer', count($refs) === count(array_unique($refs))
    && !array_filter($refs, fn($r) => !preg_match('/^C-[0-9A-F]{6}$/', $r)) && !array_intersect($refs, $real));

$tele = array_filter($a, fn($r) => $r[0] !== 'apm' && $r[0] !== 'ledger');
check('every telemetry doc labelled simulator + synthetic_user', !array_filter($tele, fn($r) => ($r[3]['labels']['data_source'] ?? '') !== 'simulator' || ($r[3]['labels']['synthetic_user'] ?? null) !== true));
$json = json_encode(array_column($tele, 3));
check('no ground truth or PII in telemetry (CAUSE, scenario, email, name)', !preg_match('/CAUSE:|"scenario"|"cause"|[a-z0-9.]+@[a-z]|"email"|"first_name"/i', $json));

// Four-problem run: start each fault and look at its signal.
$end = $t0 + 3600;
$tl = [];
foreach (Simulator::RUNS['four'] as $id => $m) $tl[] = ['id' => $id, 'start' => $end - $m * 60, 'end' => null];
$sim->setTimeline($tl);
$rows = [];
for ($t = $end - 1200; $t < $end; $t += 60) array_push($rows, ...$sim->minute($t));
$biz = array_column(array_filter($rows, fn($r) => $r[0] === 'business'), 3);
$s10 = Simulator::iso($end - Simulator::RUNS['four']['S10'] * 60);
$br17 = fn($d) => ($d['bank']['branch']['id'] ?? '') === 'BR-017';
check('S10: BR-017 active before, silent after the link drops', array_filter($biz, fn($d) => $br17($d) && $d['@timestamp'] < $s10)
    && !array_filter($biz, fn($d) => $br17($d) && $d['@timestamp'] >= $s10));
$autopay = count(array_filter($biz, fn($d) => $d['event']['category'] === 'autopay_run')) / 20;
check("S9: autopay runs drop to ~15/min ($autopay)", $autopay > 9 && $autopay < 22);
$bill = array_filter($biz, fn($d) => ($d['journey']['name'] ?? '') === 'bill_pay' && in_array($d['journey']['status'] ?? '', ['completed', 'failed', 'abandoned', 'pending'], true));
$gw = count(array_filter($bill, fn($d) => ($d['bank']['dependency'] ?? '') === 'payment_gw'));
check('S1: bill pay failures/pending attributed to payment_gw (' . $gw . ' of ' . count($bill) . ')', $gw > count($bill) * 0.3);
$otp = array_filter($biz, fn($d) => ($d['journey']['reason_code'] ?? '') === 'otp_expired');
check('S3: otp_expired concentrated in the Northeast', $otp && count(array_filter($otp, fn($d) => $d['bank']['region'] === 'Northeast')) > count($otp) * 0.8);
$ledger = array_filter($rows, fn($r) => $r[0] === 'ledger');
check('ledger: one CAUSE line per scenario started in the window (S1, S10, S3)', count($ledger) === 3
    && !array_diff(['S1', 'S10', 'S3'], array_map(fn($r) => $r[3]['scenario']['id'], $ledger)));
$synth = array_column(array_filter($rows, fn($r) => $r[0] === 'synth'), 3);
check('synthetics: 24 runs per 5 min, bill pay down in 3 locations', count($synth) === 96
    && count(array_filter($synth, fn($d) => $d['monitor']['id'] === 'journey-bill_pay' && $d['monitor']['status'] === 'down')) >= 3);
$apm = array_filter($rows, fn($r) => $r[0] === 'apm');
check('apm: transactions and payment_gw exit spans present', array_filter($apm, fn($r) => ($r[3]['event']['span']['context']['destination']['service']['resource'] ?? '') === 'payment_gw')
    && array_filter($apm, fn($r) => isset($r[3]['event']['transaction'])));

$sim->setTimeline([['id' => 'S7', 'start' => $t0, 'end' => null]]);
$tls = array_values(array_filter($sim->minute($t0 + 60 * (6 - intdiv($t0, 60) % 5)), fn($r) => ($r[3]['monitor']['id'] ?? '') === 'tls-payment-gw'));
$days = $tls ? (strtotime($tls[0][3]['tls']['server']['x509']['not_after']) - $tls[0][2]) / 86400 : null;
check('S7: payment_gw certificate expires in ~7 days', $days !== null && $days > 6.9 && $days <= 7.01, (string) $days);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
