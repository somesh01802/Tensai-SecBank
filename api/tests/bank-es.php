<?php
// SecBank Elasticsearch pipeline check against a LOCAL Elasticsearch (refuses anything else).
// Needs journey_events rows (run tests/journeys.php first).
//   ES_URL=http://127.0.0.1:9200 ES_BANK_API_KEY=x php tests/bank-es.php
require __DIR__ . '/../src/bootstrap.php';
use Tensai\{Db, Es, BankExport};

if (!preg_match('#^https?://(127\.0\.0\.1|localhost)(:\d+)?/?$#', (string) Es::env('ES_URL'))) exit("refusing: ES_URL must be a local Elasticsearch\n");
$pass = $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void {
    global $pass, $fail; $ok ? $pass++ : $fail++;
    echo ($ok ? '  PASS ' : '  FAIL ') . $name . ($ok || !$detail ? '' : "  -> $detail") . "\n";
}
$refresh = fn() => Es::req('POST', '/logs-bank.*,bank-*/_refresh', '', 'ES_BANK_API_KEY');

ob_start(); BankExport::setup(); BankExport::setup(); ob_end_clean();
check('setup runs twice (idempotent)', true);
$tpl = Es::ok('GET', '/_index_template/logs-bank.business')['index_templates'][0]['index_template'] ?? [];
check('template: priority 500, ILM bank-business-30d', ($tpl['priority'] ?? 0) === 500
    && ($tpl['template']['settings']['index']['lifecycle']['name'] ?? '') === 'bank-business-30d');
$set = Es::ok('GET', '/bank-customers/_settings');
check('bank-customers is a lookup index', (reset($set)['settings']['index']['mode'] ?? '') === 'lookup');
$refresh();
check('branches seeded (40)', (Es::ok('GET', '/bank-branches/_count')['count'] ?? 0) === 40);
check('journeys seeded (10)', (Es::ok('GET', '/bank-journeys/_count')['count'] ?? 0) === 10);

$n = (int) Db::one('SELECT count(*) AS n FROM journey_events')['n'];
check('journey_events present in Postgres', $n > 0, 'run tests/journeys.php first');
ob_start();
$f = BankExport::customers(null) + BankExport::events(null) + BankExport::events(null);   // twice: no duplicates
ob_end_clean();
$refresh();
check('export: no failures', $f === 0, (string) $f);
check('events exported once each (create + je-<id>)', (Es::ok('GET', '/' . BankExport::STREAM . '/_count')['count'] ?? -1) === $n);

$fail1 = Db::one("SELECT id FROM journey_events WHERE reason_code = 'insufficient_funds' ORDER BY id DESC LIMIT 1");
$hit = Es::ok('POST', '/' . BankExport::STREAM . '/_search', ['query' => ['ids' => ['values' => ['je-' . $fail1['id']]]]])['hits']['hits'][0]['_source'] ?? [];
check('failed event shape', ($hit['journey']['failure_class'] ?? '') === 'business' && preg_match('/^C-[0-9A-F]{6}$/', $hit['bank']['customer']['ref'] ?? '')
    && in_array($hit['bank']['customer']['segment'] ?? '', ['retail', 'premier', 'sme'], true) && isset($hit['bank']['region'])
    && ($hit['service']['name'] ?? '') === 'tensai-secbank-api' && ($hit['labels']['data_source'] ?? '') === 'app', json_encode($hit));
check('no PII in events (email/name)', !preg_match('/@test\.invalid|Journey Tester/', json_encode($hit)));

$rows = Es::esql('FROM ' . BankExport::STREAM . ' | WHERE journey.name == "bill_pay"
    | LOOKUP JOIN bank-journey-steps ON journey.step_key | STATS n = COUNT(*) BY journey.step_label | SORT n DESC');
check('ES|QL LOOKUP JOIN on bank-journey-steps', count($rows) > 0 && isset($rows[0]['journey.step_label']), json_encode($rows));
$rows = Es::esql('FROM ' . BankExport::STREAM . ' | LOOKUP JOIN bank-customers ON bank.customer.ref | STATS n = COUNT(*) BY bank.branch.id | LIMIT 5');
check('ES|QL LOOKUP JOIN on bank-customers (home branch)', count($rows) > 0 && isset($rows[0]['bank.branch.id']), json_encode($rows));

ob_start(); $hf = BankExport::health(240); BankExport::health(240); ob_end_clean();
$refresh();
$h = Es::esql('FROM ' . BankExport::HEALTH . ' | STATS docs = COUNT(*), minutes = COUNT_DISTINCT(@timestamp) BY journey.name, labels.synthetic_user | LIMIT 100');
$dup = array_filter($h, fn($r) => $r['docs'] !== $r['minutes']);
check('health docs written, one per journey/minute/flag (re-run safe)', $hf === 0 && $h && !$dup, json_encode($h));
$doc = Es::ok('POST', '/' . BankExport::HEALTH . '/_search', ['size' => 1, 'query' => ['term' => ['journey.name' => 'login']]])['hits']['hits'][0]['_source']['health'] ?? [];
check('login health has JHI in 0..100 and a band', isset($doc['index']) && $doc['index'] >= 0 && $doc['index'] <= 100
    && in_array($doc['band'], ['healthy', 'watch', 'critical'], true), json_encode($doc));

// Formula spot check: 10 attempts, 9 completed (8 fast, 1 slow-tolerating), 1 technical fail, SLO 99.5, 4/5 page views pass.
$d = BankExport::healthDoc(['minute' => '2026-01-01T00:00:00.000Z', 'journey.name' => 'x', 'labels.synthetic_user' => false,
    'attempts' => 10, 'completed' => 9, 'tech_failures' => 1, 'satisfied' => 8, 'tolerating' => 1, 'value_failed' => 0],
    99.5, ['views' => 5, 'pass' => 4])['health'];
$exp = round(100 * (0.40 * (0.9 / 0.995) + 0.25 * 0.85 + 0.20 * 0 + 0.15 * 0.8), 1);
check("JHI formula ($exp, band critical)", $d['index'] === $exp && $d['band'] === 'critical', json_encode($d));

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
