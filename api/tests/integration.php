<?php
/**
 * End-to-end tests for the 0007 upgrade, against a RUNNING API + its database.
 * Creates throw-away users (…@test.invalid "real", …@loadtest.tensai.test
 * synthetic) and one admin — run it on a local/staging stack, not production.
 *
 *   php tests/integration.php --base=http://127.0.0.1:8090 --allow-writes
 *
 * Needs the API's api/.env (DATABASE_URL) for direct DB assertions, and the API
 * running with FAULT_INJECTION_ENABLED=true (the fault tests check both sides:
 * honoured for synthetic users, ignored for real ones). Exit code 0 = all passed.
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\Db;

$o = getopt('', ['base::', 'allow-writes']);
if (!isset($o['allow-writes'])) { fwrite(STDERR, "Creates test users/transactions. Re-run with --allow-writes (local/staging only).\n"); exit(2); }
$BASE = rtrim($o['base'] ?? 'http://127.0.0.1:8090', '/');
$RUN = (string) time();
$PASS = 0; $FAIL = 0;

function check(string $name, bool $ok, string $detail = ''): void
{
    global $PASS, $FAIL;
    $ok ? $PASS++ : $FAIL++;
    printf("  %s %s%s\n", $ok ? 'PASS' : 'FAIL', $name, $ok || $detail === '' ? '' : "  → $detail");
}

function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/** @return array{0:int,1:array} */
function req(string $method, string $path, ?array $body = null, ?string $token = null, array $headers = []): array
{
    global $BASE;
    $h = array_merge(['Accept: application/json'], $headers);
    if ($body !== null) $h[] = 'Content-Type: application/json';
    if ($token) $h[] = "Authorization: Bearer $token";
    $ch = curl_init("$BASE/api$path");
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 30]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, is_string($raw) ? (json_decode($raw, true) ?: []) : []];
}

function register(string $email, string $name, array $extra = []): array
{
    $mobile = '5' . str_pad((string) random_int(0, 999999999), 9, '0', STR_PAD_LEFT);
    [$c, $j] = req('POST', '/auth/register', ['name' => $name, 'email' => $email, 'password' => 'Test-Pass-123', 'mobileNumber' => $mobile] + $extra);
    if ($c !== 201) { fwrite(STDERR, "register $email failed: $c " . json_encode($j) . "\n"); exit(1); }
    return ['email' => $email, 'id' => $j['user']['id'], 'token' => $j['token'], 'reg' => $j];
}

function primary(array $u): array
{
    [, $j] = req('GET', '/accounts', null, $u['token']);
    foreach ($j['accounts'] ?? [] as $a) if (!empty($a['isPrimary'])) return ['id' => $a['id'], 'balance' => (float) $a['balance']];
    return ['id' => $j['accounts'][0]['id'] ?? null, 'balance' => (float) ($j['accounts'][0]['balance'] ?? 0)];
}

function balance(array $u): float { return primary($u)['balance']; }

/** Recursively collect keys and string values (for the "no secrets" check). */
function walk($v, array &$keys, array &$vals): void
{
    if (!is_array($v)) { if (is_string($v)) $vals[] = $v; return; }
    foreach ($v as $k => $x) { if (is_string($k)) $keys[] = $k; walk($x, $keys, $vals); }
}

echo "Tensai SecBank integration tests → $BASE (run $RUN)\n";

// ---------------------------------------------------------------- 1. auth + roles
echo "[roles & registration]\n";
$r1 = register("real1-$RUN@test.invalid", 'Real One', ['role' => 'ADMIN', 'isSynthetic' => true]);
$r2 = register("real2-$RUN@test.invalid", 'Real Two');
$s1 = register("s1-$RUN@loadtest.tensai.test", 'Synthetic One');
$s2 = register("s2-$RUN@loadtest.tensai.test", 'Synthetic Two');
check('registration ignores a client-supplied role (always CUSTOMER)', ($r1['reg']['user']['role'] ?? null) === 'CUSTOMER');
$flags = Db::all('SELECT email, role, is_synthetic FROM users WHERE email IN (:a,:b)', [':a' => $r1['email'], ':b' => $s1['email']]);
$byEmail = array_column($flags, null, 'email');
check('registration ignores a client-supplied synthetic flag', ($byEmail[$r1['email']]['isSynthetic'] ?? true) === false);
check('reserved test domain is flagged synthetic server-side', ($byEmail[$s1['email']]['isSynthetic'] ?? false) === true);
check('register returns a loginEventId', !empty($r1['reg']['loginEventId']));

$adminEmail = "admin-$RUN@ops.test.invalid";
$adminPass = 'Adm1n-' . bin2hex(random_bytes(6));
$cmd = sprintf('%s %s --email=%s --name=%s', escapeshellarg(PHP_BINARY), escapeshellarg(__DIR__ . '/../bin/create-admin.php'),
    escapeshellarg($adminEmail), escapeshellarg('Test Admin'));
putenv("ADMIN_PASSWORD=$adminPass");
exec($cmd . ' 2>&1', $out, $rc);
putenv('ADMIN_PASSWORD');
check('bin/create-admin.php provisions an admin', $rc === 0, implode(' ', $out));

[$c, $j] = req('POST', '/auth/login', ['email' => $r1['email'], 'password' => 'Test-Pass-123', 'loginAs' => 'admin']);
check('customer cannot sign in through the Admin option (403)', $c === 403, "$c");
[$c] = req('POST', '/auth/login', ['email' => $adminEmail, 'password' => $adminPass]);
check('admin cannot sign in through the Customer option (403)', $c === 403, "$c");
[$c, $j] = req('POST', '/auth/login', ['email' => $adminEmail, 'password' => $adminPass, 'loginAs' => 'admin']);
check('admin signs in through the Admin option', $c === 200 && ($j['user']['role'] ?? null) === 'ADMIN', "$c");
$adminToken = $j['token'] ?? '';
[$c] = req('POST', '/auth/login', ['email' => $adminEmail, 'mpin' => '123456', 'loginAs' => 'admin']);
check('admin sign-in rejects MPIN (password only)', $c === 400, "$c");

[$c] = req('GET', '/admin/customers', null, $r1['token']);
check('customer token is refused on admin API (403)', $c === 403, "$c");
[$c] = req('GET', '/admin/summary');
check('admin API without a token is refused (401)', $c === 401, "$c");
$denied = Db::one("SELECT count(*) AS n FROM audit_logs WHERE user_id = :u AND event_type IN ('admin.access_denied','admin.login_denied')", [':u' => $r1['id']]);
check('denied admin attempts are audited', (int) $denied['n'] >= 2, json_encode($denied));

// ---------------------------------------------------------------- 2. location consent
echo "[login location]\n";
$sid = uuid();
[$c, $login] = req('POST', '/auth/login', ['email' => $r1['email'], 'password' => 'Test-Pass-123'], null, ["X-Session-Id: $sid"]);
$r1['token'] = $login['token'];
$ev = $login['loginEventId'] ?? null;
check('login returns a loginEventId', $c === 200 && is_int($ev), "$c");
$ses = Db::one('SELECT session_id FROM login_events WHERE id = :i', [':i' => $ev]);
check('login event stores the session id', ($ses['sessionId'] ?? null) === $sid);
[$c] = req('POST', '/auth/location', ['loginEventId' => $ev, 'status' => 'granted', 'latitude' => 19.076090, 'longitude' => 72.877426, 'accuracy' => 35.5], $r1['token']);
check('granted location with coordinates is stored (201)', $c === 201, "$c");
$loc = Db::one('SELECT status, latitude, longitude, accuracy_m, session_id FROM login_locations WHERE login_event_id = :i', [':i' => $ev]);
check('stored coordinates/accuracy/session are exact', $loc && (float) $loc['latitude'] === 19.07609 && (float) $loc['longitude'] === 72.877426
    && (float) $loc['accuracyM'] === 35.5 && $loc['sessionId'] === $sid, json_encode($loc));
[$c] = req('POST', '/auth/location', ['loginEventId' => $ev, 'status' => 'denied'], $r1['token']);
check('second location for the same login is rejected (409)', $c === 409, "$c");
[$c] = req('POST', '/auth/location', ['loginEventId' => $ev, 'status' => 'denied'], $r2['token']);
check("another user's login event is not found (404)", $c === 404, "$c");
[, $l2] = req('POST', '/auth/login', ['email' => $r2['email'], 'password' => 'Test-Pass-123']);
$r2['token'] = $l2['token'];
[$c] = req('POST', '/auth/location', ['loginEventId' => $l2['loginEventId'], 'status' => 'granted'], $r2['token']);
check('granted without coordinates is rejected (400)', $c === 400, "$c");
[$c] = req('POST', '/auth/location', ['loginEventId' => $l2['loginEventId'], 'status' => 'granted', 'latitude' => 95, 'longitude' => 10], $r2['token']);
check('out-of-range latitude is rejected (400)', $c === 400, "$c");
[$c] = req('POST', '/auth/location', ['loginEventId' => $l2['loginEventId'], 'status' => 'denied', 'latitude' => 10, 'longitude' => 10], $r2['token']);
$loc2 = Db::one('SELECT status, latitude FROM login_locations WHERE login_event_id = :i', [':i' => $l2['loginEventId']]);
check('denied is recorded honestly and never stores coordinates', $c === 201 && $loc2['status'] === 'denied' && $loc2['latitude'] === null, json_encode($loc2));

// ---------------------------------------------------------------- 3. transaction attempts
echo "[transaction attempts & ledger integrity]\n";
$a1 = primary($r1); $a2 = primary($r2); $sa1 = primary($s1); $sa2 = primary($s2);
$key = uuid();
$p2p = ['fromAccount' => $a1['id'], 'toAccount' => $a2['id'], 'amount' => 100, 'idempotencyKey' => $key, 'description' => 'test p2p'];
[$c, $ok] = req('POST', '/transactions', $p2p, $r1['token'], ["X-Session-Id: $sid"]);
check('P2P succeeds and returns attemptId', $c === 201 && !empty($ok['attemptId']), "$c " . json_encode($ok));
$okAttempt = Db::one('SELECT * FROM transaction_attempts WHERE id = :i', [':i' => $ok['attemptId'] ?? uuid()]);
check('success attempt row links the transaction, session, real flag', $okAttempt && $okAttempt['outcome'] === 'SUCCESS'
    && $okAttempt['transactionId'] === ($ok['transaction']['id'] ?? null) && $okAttempt['sessionId'] === $sid && $okAttempt['isSynthetic'] === false,
    json_encode($okAttempt));
check('balances moved by exactly the amount', abs(balance($r1) - ($a1['balance'] - 100)) < 0.001 && abs(balance($r2) - ($a2['balance'] + 100)) < 0.001);
[$c, $dup] = req('POST', '/transactions', $p2p, $r1['token']);
check('retry with the same idempotency key does not double-post', $c === 200 && ($dup['transaction']['id'] ?? 0) === ($ok['transaction']['id'] ?? 1)
    && abs(balance($r1) - ($a1['balance'] - 100)) < 0.001, "$c");

$before = balance($r1);
[$c, $insuf] = req('POST', '/transactions', array_merge($p2p, ['amount' => $before + 1000, 'idempotencyKey' => uuid()]), $r1['token']);
check('insufficient funds → 400 insufficient_funds with attemptId', $c === 400 && ($insuf['errorCategory'] ?? '') === 'insufficient_funds' && !empty($insuf['attemptId']), json_encode($insuf));
check('failed transfer leaves balance unchanged', abs(balance($r1) - $before) < 0.001);
$fa = Db::one('SELECT outcome, transaction_id, error_category FROM transaction_attempts WHERE id = :i', [':i' => $insuf['attemptId'] ?? uuid()]);
check('failure attempt row: FAILURE, no transaction, category', $fa && $fa['outcome'] === 'FAILURE' && $fa['transactionId'] === null && $fa['errorCategory'] === 'insufficient_funds');

[$c, $lim] = req('POST', '/transactions', array_merge($p2p, ['amount' => 500001, 'idempotencyKey' => uuid()]), $r1['token']);
check('over the per-transaction limit → transfer_limit', $c === 400 && ($lim['errorCategory'] ?? '') === 'transfer_limit', json_encode($lim));
[$c, $inv] = req('POST', '/transactions', array_merge($p2p, ['toAccount' => uuid(), 'idempotencyKey' => uuid()]), $r1['token']);
check('unknown beneficiary account → invalid_beneficiary', $c === 404 && ($inv['errorCategory'] ?? '') === 'invalid_beneficiary', json_encode($inv));
[$c, $mix] = req('POST', '/transactions', array_merge($p2p, ['toAccount' => $sa1['id'], 'idempotencyKey' => uuid()]), $r1['token']);
check('live → synthetic transfer is refused', $c === 400 && ($mix['errorCategory'] ?? '') === 'invalid_beneficiary', json_encode($mix));
[$c] = req('POST', '/transactions', ['fromAccount' => $sa1['id'], 'toAccount' => $a1['id'], 'amount' => 5, 'idempotencyKey' => uuid()], $s1['token']);
check('synthetic → live transfer is refused', $c === 400, "$c");

$b1 = balance($r1);
[$c] = req('POST', '/transactions', array_merge($p2p, ['amount' => 1, 'idempotencyKey' => uuid()]), $r1['token'], ['X-Tensai-Fault: processor_timeout']);
check('fault header is IGNORED for a real customer (transfer succeeds)', $c === 201, "$c");
$sb1 = balance($s1); $sb2 = balance($s2);
[$c, $flt] = req('POST', '/transactions', ['fromAccount' => $sa1['id'], 'toAccount' => $sa2['id'], 'amount' => 7, 'idempotencyKey' => uuid()],
    $s1['token'], ['X-Tensai-Fault: processor_timeout']);
check('fault header is honoured for a synthetic user (504 processor_timeout)', $c === 504 && ($flt['errorCategory'] ?? '') === 'processor_timeout', "$c " . json_encode($flt));
check('injected fault moves no money', abs(balance($s1) - $sb1) < 0.001 && abs(balance($s2) - $sb2) < 0.001);
$fi = Db::one('SELECT fault_injected, is_synthetic FROM transaction_attempts WHERE id = :i', [':i' => $flt['attemptId'] ?? uuid()]);
check('injected attempt is flagged fault_injected + synthetic', $fi && $fi['faultInjected'] === true && $fi['isSynthetic'] === true);
foreach (['network_failure' => 502, 'fraud_timeout' => 504, 'db_concurrency' => 409, 'service_outage' => 503] as $fault => $st) {
    [$c, $j] = req('POST', '/transfer/quick', ['bankName' => 'HDFC Bank', 'accountNumber' => '123456789012', 'confirmAccountNumber' => '123456789012',
        'accountHolderName' => 'X', 'amount' => 3, 'sourceAccountId' => $sa1['id'], 'idempotencyKey' => uuid()], $s1['token'], ["X-Tensai-Fault: $fault"]);
    check("injected $fault → $st", $c === $st && ($j['errorCategory'] ?? '') === $fault, "$c");
}
[$c, $ext] = req('POST', '/transfer/quick', ['bankName' => 'HDFC Bank', 'accountNumber' => '123456789012', 'confirmAccountNumber' => '123456789012',
    'accountHolderName' => 'Ext Payee', 'amount' => 11, 'sourceAccountId' => $sa1['id'], 'idempotencyKey' => uuid()], $s1['token']);
$ea = Db::one('SELECT kind, target FROM transaction_attempts WHERE id = :i', [':i' => $ext['attemptId'] ?? uuid()]);
check('external transfer records EXTERNAL attempt with a masked target', $c === 201 && $ea['kind'] === 'EXTERNAL'
    && str_contains((string) $ea['target'], '••••9012') && !str_contains((string) $ea['target'], '123456789012'), json_encode($ea));

// ---------------------------------------------------------------- 4. bills (security fixes)
echo "[bill payment]\n";
[, $bill] = req('POST', '/bills', ['billerName' => 'Test Power', 'category' => 'ELECTRICITY', 'amount' => 25], $r1['token']);
$billId = $bill['bill']['id'];
[$c] = req('POST', "/bills/$billId/pay", ['fromAccountId' => $a2['id']], $r2['token']);
check("cannot pay someone else's bill (404)", $c === 404, "$c");
$r2Before = balance($r2);
[$c, $j] = req('POST', "/bills/$billId/pay", ['fromAccountId' => $a2['id']], $r1['token']);
check("cannot pay from someone else's account (404, previously allowed)", $c === 404 && abs(balance($r2) - $r2Before) < 0.001, "$c");
$r1Before = balance($r1);
[$c, $paid] = req('POST', "/bills/$billId/pay", ['fromAccountId' => $a1['id']], $r1['token']);
check('own bill payment succeeds and debits once', $c === 200 && abs(balance($r1) - ($r1Before - 25)) < 0.001 && !empty($paid['attemptId']), "$c");
[$c] = req('POST', "/bills/$billId/pay", ['fromAccountId' => $a1['id']], $r1['token']);
check('paying an already-paid bill does not debit again', $c === 200 && abs(balance($r1) - ($r1Before - 25)) < 0.001);
[, $big] = req('POST', '/bills', ['billerName' => 'Huge Bill', 'category' => 'OTHER', 'amount' => 99999999], $r1['token']);
[$c, $j] = req('POST', "/bills/{$big['bill']['id']}/pay", ['fromAccountId' => $a1['id']], $r1['token']);
$st = Db::one('SELECT status FROM bills WHERE id = :i', [':i' => $big['bill']['id']]);
check('bill larger than the balance is refused and stays DUE (previously went negative)', $c === 400
    && ($j['errorCategory'] ?? '') === 'insufficient_funds' && $st['status'] === 'DUE', "$c " . json_encode($j));

// ---------------------------------------------------------------- 5. feedback
echo "[feedback]\n";
[$c] = req('POST', '/feedback', ['attemptId' => $ok['attemptId'], 'rating' => 'HAPPY', 'comment' => 'Smooth!'], $r1['token']);
check('feedback on a successful attempt (201)', $c === 201, "$c");
[$c] = req('POST', '/feedback', ['attemptId' => $ok['attemptId'], 'rating' => 'SATISFIED'], $r1['token']);
check('duplicate feedback is rejected (409)', $c === 409, "$c");
[$c] = req('POST', '/feedback', ['attemptId' => $insuf['attemptId'], 'rating' => 'HAPPY'], $r2['token']);
check("feedback on another user's attempt is not found (404)", $c === 404, "$c");
[$c] = req('POST', '/feedback', ['attemptId' => $insuf['attemptId'], 'rating' => 'MEH'], $r1['token']);
check('invalid rating is rejected (400)', $c === 400, "$c");
[$c] = req('POST', '/feedback', ['attemptId' => $lim['attemptId'], 'rating' => 'NOT_SATISFIED', 'comment' => str_repeat('x', 501)], $r1['token']);
check('comment over 500 chars is rejected (400)', $c === 400, "$c");
[$c] = req('POST', '/feedback', ['attemptId' => $insuf['attemptId'], 'dismissed' => true], $r1['token']);
$fd = Db::one('SELECT status, rating FROM transaction_feedback WHERE attempt_id = :a', [':a' => $insuf['attemptId']]);
check('dismissal on a failed attempt is recorded (no rating)', $c === 201 && $fd['status'] === 'DISMISSED' && $fd['rating'] === null);
$cnt = Db::one('SELECT count(*) AS n FROM transactions WHERE id = :t', [':t' => $ok['transaction']['id']]);
check('feedback never alters the transaction', (int) $cnt['n'] === 1 && abs(balance($r2) - $r2Before) < 0.001);

// ---------------------------------------------------------------- 6. admin dashboard API
echo "[admin API]\n";
req('POST', '/cards', ['type' => 'DEBIT', 'brand' => 'VISA'], $r1['token']); // give R1 a card with a full number + CVV on file
[$c, $sum] = req('GET', '/admin/summary', null, $adminToken);
check('admin summary', $c === 200 && isset($sum['attempts24h']['failure']), "$c");
[$c, $list] = req('GET', '/admin/customers?q=' . urlencode("real1-$RUN") . '&pageSize=5', null, $adminToken);
check('customer search + pagination', $c === 200 && $list['total'] === 1 && $list['items'][0]['id'] === $r1['id'], "$c");
check('mobile number is masked in lists', str_contains($list['items'][0]['mobile'] ?? '', '•'));
[$c, $det] = req('GET', "/admin/customers/{$r1['id']}", null, $adminToken);
$keys = []; $vals = []; walk($det, $keys, $vals);
$bad = preg_grep('/password|mpin|cvv|full_?number|token|secret/i', $keys);
$hashes = preg_grep('/^\$2[aby]\$/', $vals);
check('customer detail has accounts, cards, loans, bills, attempts, logins', $c === 200
    && isset($det['accounts'], $det['cards'], $det['loans'], $det['bills'], $det['attempts'], $det['logins']) && count($det['cards']) >= 1, "$c");
check('customer detail exposes no password/MPIN/CVV/card number/token', !$bad && !$hashes, json_encode(array_values($bad)));
[$c, $tx] = req('GET', '/admin/transactions?outcome=FAILURE&q=' . urlencode("real1-$RUN"), null, $adminToken);
$ids = array_column($tx['items'] ?? [], 'refId');
check('transactions filter (outcome=FAILURE) lists failed attempts', $c === 200 && in_array($insuf['attemptId'], $ids, true), "$c");
[$c, $tx] = req('GET', '/admin/transactions?errorCategory=processor_timeout&synthetic=synthetic&q=' . urlencode("s1-$RUN"), null, $adminToken);
check('transactions filter (category + synthetic)', $c === 200 && $tx['total'] >= 1, "$c");
[$c, $one] = req('GET', "/admin/transactions/{$ok['transaction']['id']}", null, $adminToken);
$deb = array_sum(array_map(fn($l) => $l['type'] === 'DEBIT' ? $l['amount'] : 0, $one['ledger'] ?? []));
check('transaction detail with balanced ledger + attempt + feedback', $c === 200 && abs($deb - 100) < 0.001
    && ($one['attempts'][0]['feedbackRating'] ?? null) === 'HAPPY', "$c");
[$c, $one] = req('GET', "/admin/transactions/{$insuf['attemptId']}", null, $adminToken);
check('failed-attempt detail', $c === 200 && $one['type'] === 'ATTEMPT' && $one['attempt']['errorCategory'] === 'insufficient_funds', "$c");
[$c, $fb] = req('GET', '/admin/feedback?rating=HAPPY', null, $adminToken);
check('feedback list filter', $c === 200 && in_array($ok['attemptId'], array_column($fb['items'] ?? [], 'attemptId'), true), "$c");
$aud = Db::one("SELECT count(*) AS n FROM audit_logs WHERE event_type = 'admin.view_customer' AND entity_id = :u", [':u' => $r1['id']]);
check('admin views are audited', (int) $aud['n'] >= 1);
[$c, $al] = req('GET', '/admin/audit', null, $adminToken);
check('audit log endpoint', $c === 200 && $al['total'] >= 1, "$c");

// ---------------------------------------------------------------- 7. global ledger integrity
echo "[ledger integrity]\n";
$users = [$r1['id'], $r2['id'], $s1['id'], $s2['id']];
$neg = Db::one("SELECT count(*) AS n FROM (SELECT a.id, SUM(CASE WHEN le.type='CREDIT' THEN le.amount ELSE -le.amount END) AS bal
    FROM accounts a JOIN ledger_entries le ON le.account_id = a.id WHERE a.user_id IN (:a,:b,:c,:d) GROUP BY a.id) x WHERE bal < 0",
    [':a' => $users[0], ':b' => $users[1], ':c' => $users[2], ':d' => $users[3]]);
check('no test account has a negative balance', (int) $neg['n'] === 0);
$mis = Db::one("SELECT count(*) AS n FROM transactions t
    WHERE t.created_at >= to_timestamp(:run) AND t.status = 'COMPLETED'
      AND (SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE transaction_id = t.id AND type = 'DEBIT') <> t.amount
      AND t.category IS DISTINCT FROM 'WELCOME_BONUS'", [':run' => (int) $RUN]);
check('every completed transaction since the run has exactly one matching DEBIT', (int) $mis['n'] === 0, json_encode($mis));
$p2pBal = Db::one("SELECT count(*) AS n FROM transactions t WHERE t.created_at >= to_timestamp(:run) AND t.status = 'COMPLETED'
      AND t.from_account_id <> t.to_account_id
      AND (SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE transaction_id = t.id AND type = 'CREDIT') <> t.amount", [':run' => (int) $RUN]);
check('every internal transfer since the run is balanced (CREDIT = DEBIT)', (int) $p2pBal['n'] === 0);

// ---------------------------------------------------------------- 8. export → existing indices
echo "[telemetry export → existing Kibana indices (mock Elasticsearch)]\n";
$log = sys_get_temp_dir() . "/mock-es-$RUN.log";
$port = 9300 + random_int(0, 500);
$env = array_merge(getenv(), ['MOCK_ES_LOG' => $log]);
$srv = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/mock-es.php'], [1 => ['file', sys_get_temp_dir() . '/mock-es-out.txt', 'w'],
    2 => ['file', sys_get_temp_dir() . '/mock-es-err.txt', 'w']], $pipes, null, $env);
usleep(700000);
$exp = proc_open([PHP_BINARY, __DIR__ . '/../bin/export-to-elastic.php'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $p2, __DIR__ . '/..',
    array_merge(getenv(), ['ES_URL' => "http://127.0.0.1:$port", 'ES_API_KEY' => 'dGVzdA==']));
$expOut = stream_get_contents($p2[1]) . stream_get_contents($p2[2]);
$expRc = proc_close($exp);
proc_terminate($srv);
check('exporter succeeds against existing indices', $expRc === 0, trim($expOut));
$reqs = array_map(fn($l) => json_decode($l, true), array_filter(explode("\n", (string) @file_get_contents($log))));
$created = array_filter($reqs, fn($r) => $r['method'] === 'PUT' && !str_contains($r['path'], '_mapping'));
$mapped = array_values(array_filter($reqs, fn($r) => $r['path'] === '/tensai-login-events/_mapping'));
$geo = $mapped ? (json_decode($mapped[0]['body'], true)['properties']['geo_location']['type'] ?? null) : null;
check('only the four existing tensai-* indices are targeted (no new index)', !array_diff(array_unique(array_column($created, 'path')),
    ['/tensai-users', '/tensai-accounts', '/tensai-transactions', '/tensai-login-events']));
check('existing index gets an additive mapping (geo_location: geo_point)', $geo === 'geo_point');
$docs = [];
foreach ($reqs as $r) {
    if ($r['path'] !== '/_bulk') continue;
    $lines = array_values(array_filter(explode("\n", $r['body'])));
    for ($i = 0; $i + 1 < count($lines); $i += 2) {
        $a = json_decode($lines[$i], true)['index'];
        $docs[$a['_index']][$a['_id']] = json_decode($lines[$i + 1], true);
    }
}
$fd = $docs['tensai-transactions'][$insuf['attemptId']] ?? null;
check('failed attempt → tensai-transactions (status FAILED, record_type, category)', $fd && $fd['status'] === 'FAILED'
    && $fd['record_type'] === 'failed_attempt' && $fd['error_category'] === 'insufficient_funds' && $fd['is_synthetic'] === false
    && $fd['feedback_status'] === 'dismissed', json_encode($fd));
$td = $docs['tensai-transactions'][$ok['transaction']['id']] ?? null;
check('completed transaction keeps its _id and gains attempt/feedback/correlation fields', $td && $td['transaction_id'] === $ok['transaction']['id']
    && $td['attempt_id'] === $ok['attemptId'] && $td['feedback_rating'] === 'HAPPY' && $td['session_id'] === $sid
    && $td['outcome'] === 'success' && isset($td['duration_ms'], $td['user_ref']) && isset($td['from_user'], $td['amount']), json_encode($td));
$sd = $docs['tensai-transactions'][$flt['attemptId']] ?? null;
check('synthetic failure is classified synthetic', $sd && $sd['is_synthetic'] === true && $sd['error_category'] === 'processor_timeout');
$ld = $docs['tensai-login-events'][(string) $ev] ?? null;
check('login event carries coarsened geo_location + consent status', $ld && $ld['location_status'] === 'granted'
    && $ld['geo_location'] === ['lat' => 19.08, 'lon' => 72.88] && $ld['session_id'] === $sid, json_encode($ld));
$ld2 = $docs['tensai-login-events'][(string) $l2['loginEventId']] ?? null;
check('denied login has status but no coordinates', $ld2 && $ld2['location_status'] === 'denied' && $ld2['geo_location'] === null);
$all = json_encode($docs);
check('no password hash / token / CVV / full card number in exported docs',
    !preg_match('/\$2[aby]\$|eyJhbGciOi|"cvv"|"full_number"/', $all));
@unlink($log);

printf("\n%d passed, %d failed\n", $PASS, $FAIL);
exit($FAIL ? 1 : 0);
