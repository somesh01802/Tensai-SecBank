<?php
// Security regression tests for the VAPT fixes (2026-11-02). LOCAL ONLY: creates users and moves test money.
//   php tests/security.php --base=http://127.0.0.1:8090 --allow-writes
require __DIR__ . '/../src/bootstrap.php';
use Tensai\{Db, Ledger, Scheduler};

$opt = getopt('', ['base:', 'allow-writes']);
if (!isset($opt['allow-writes'])) exit("refusing to run without --allow-writes (creates users, moves test money)\n");
if (!preg_match('#@(127\.0\.0\.1|localhost)[:/]#', (string) ($_ENV['DATABASE_URL'] ?? ''))) exit("refusing: DATABASE_URL is not a local database\n");
$base = rtrim($opt['base'] ?? 'http://127.0.0.1:8090', '/') . '/api';
$pass = $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void {
    global $pass, $fail; $ok ? $pass++ : $fail++;
    echo ($ok ? '  PASS ' : '  FAIL ') . $name . ($ok || !$detail ? '' : "  -> $detail") . "\n";
}
function call(string $m, string $p, ?array $body = null, ?string $tok = null, array $h = []): array {
    global $base;
    $ch = curl_init($base . $p);
    $hdr = array_merge(['Content-Type: application/json'], $h);
    if ($tok) $hdr[] = "Authorization: Bearer $tok";
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $m, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $hdr, CURLOPT_HEADER => true,
        CURLOPT_POSTFIELDS => $body === null ? null : json_encode($body)]);
    $raw = (string) curl_exec($ch); $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    return [curl_getinfo($ch, CURLINFO_HTTP_CODE), json_decode(substr($raw, $hs), true) ?? substr($raw, $hs), substr($raw, 0, $hs)];
}
function uuid(): string { $b = random_bytes(16); $b[6] = chr((ord($b[6]) & 0x0f) | 0x40); $b[8] = chr((ord($b[8]) & 0x3f) | 0x80); return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4)); }
function user(string $tag, bool $synthetic = true): array {
    $email = "sec-$tag-" . bin2hex(random_bytes(3)) . ($synthetic ? '@sec.tensai.test' : '@test.invalid');
    $pw = 'Sec-' . bin2hex(random_bytes(6));
    [$c, $r] = call('POST', '/auth/register', ['name' => "SEC $tag", 'email' => $email, 'password' => $pw, 'mobileNumber' => '6' . random_int(100000000, 999999999)]);
    if ($c !== 201) exit("register failed: $c\n");
    $acc = Db::one('SELECT id FROM accounts WHERE user_id = :u AND is_primary = true', [':u' => $r['user']['id']])['id'];
    return ['email' => $email, 'pw' => $pw, 'tok' => $r['token'], 'id' => $r['user']['id'], 'acc' => $acc];
}
function bal(string $a): float { return (float) Db::one("SELECT COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS b FROM ledger_entries WHERE account_id=:a", [':a' => $a])['b']; }
$clearIp = fn() => Db::run("DELETE FROM auth_failures WHERE ip IN ('127.0.0.1', '::1')");
$clearIp();

echo "[VAPT-01 double spend]\n";
$u = Db::one("INSERT INTO users (email, name, password_hash, mobile_number, is_synthetic) VALUES (:e, 'SEC race', 'x', :m, true) RETURNING id",
    [':e' => 'sec-race-' . bin2hex(random_bytes(4)) . '@sec.tensai.test', ':m' => '5' . random_int(100000000, 999999999)]);
$acc = Db::one('INSERT INTO accounts (user_id) VALUES (:u) RETURNING id', [':u' => $u['id']])['id'];
$tx = Db::one("INSERT INTO transactions (from_account_id, to_account_id, amount, status, idempotency_key, category) VALUES (:a,:a,'1000.00','COMPLETED',:k,'DEPOSIT') RETURNING id", [':a' => $acc, ':k' => uuid()]);
Db::run("INSERT INTO ledger_entries (account_id, transaction_id, type, amount) VALUES (:a,:t,'CREDIT','1000.00')", [':a' => $acc, ':t' => $tx['id']]);
$worker = '<?php require ' . var_export(__DIR__ . '/../src/bootstrap.php', true) . '; Tensai\Db::pdo()->query("SELECT 1");'
    . ' while (microtime(true) < (float) $argv[2]) usleep(50);'
    . ' try { Tensai\Ledger::debit($argv[1], 900, bin2hex(random_bytes(8)), "race", "TEST"); echo "OK"; } catch (Throwable $e) { echo "NO"; }';
$wf = tempnam(sys_get_temp_dir(), 'race') . '.php'; file_put_contents($wf, $worker);
$go = microtime(true) + 3; $procs = []; $pipes = [];
for ($i = 0; $i < 10; $i++) $procs[] = proc_open([PHP_BINARY, $wf, $acc, (string) $go], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$i]);
$ok = 0; foreach ($procs as $i => $p) { $ok += trim(stream_get_contents($pipes[$i][1])) === 'OK'; proc_close($p); }
@unlink($wf);
check("10 simultaneous debits of 900 from 1,000.00: exactly one succeeds ($ok), balance stays non-negative (" . bal($acc) . ')', $ok === 1 && abs(bal($acc) - 100) < 0.001);

echo "[VAPT-02 money creation]\n";
$real = user('real', false); $syn = user('syn');
[$c] = call('POST', '/transactions/receive', ['amount' => 1000, 'idempotencyKey' => uuid()], $real['tok']);
check('real customer self-deposit refused (403)', $c === 403, (string) $c);
$b0 = bal($syn['acc']);
[$c] = call('POST', '/transactions/receive', ['amount' => 250, 'idempotencyKey' => uuid()], $syn['tok']);
check('synthetic (test) user deposit still works', $c === 201 && abs(bal($syn['acc']) - $b0 - 250) < 0.001, (string) $c);

echo "[VAPT-03 debiting another customer]\n";
$V = user('victim'); $M = user('mallory');
call('POST', '/payees', ['bankName' => 'HDFC Bank', 'accountNumber' => '999988887777', 'confirmAccountNumber' => '999988887777', 'accountHolderName' => 'Ext', 'nickname' => 'e'], $M['tok']);
$payee = Db::one('SELECT id FROM payees WHERE user_id = :u', [':u' => $M['id']])['id'];
[, $ir] = call('POST', '/investments', ['name' => 'SEC fund', 'type' => 'MUTUAL_FUND', 'investedAmount' => 1], $M['tok']);
$inv = Db::one('SELECT id FROM investments WHERE user_id = :u', [':u' => $M['id']])['id'];
$past = gmdate('Y-m-d\TH:i:s\Z', time() - 60);
[$c1] = call('POST', '/transfer/scheduled', ['payeeId' => $payee, 'sourceAccountId' => $V['acc'], 'amount' => 700, 'nextRunAt' => $past], $M['tok']);
[$c2] = call('POST', '/autopay', ['investmentId' => $inv, 'sourceAccountId' => $V['acc'], 'amount' => 300, 'nextRunAt' => $past], $M['tok']);
[$c3] = call('POST', '/recurring-bills', ['billerName' => 'SEC Power', 'category' => 'ELECTRICITY', 'amount' => 200, 'sourceAccountId' => $V['acc'], 'nextRunAt' => $past], $M['tok']);
check("foreign source account refused on scheduled transfer / autopay / recurring bill ($c1/$c2/$c3)", $c1 === 404 && $c2 === 404 && $c3 === 404);
[$c] = call('POST', '/transfer/scheduled', ['payeeId' => $payee, 'sourceAccountId' => $M['acc'], 'amount' => 5, 'nextRunAt' => $past], $M['tok']);
check('own source account still accepted', $c === 201, (string) $c);
// A malicious schedule already in the database (created before the fix) must not run.
Db::run("INSERT INTO scheduled_transfers (user_id, payee_id, source_account_id, amount, frequency, next_run_at, enabled, status)
         VALUES (:u, :p, :s, '700.00', 'ONCE', now() - interval '1 minute', true, 'SCHEDULED')", [':u' => $M['id'], ':p' => $payee, ':s' => $V['acc']]);
$vb = bal($V['acc']); $mb = bal($M['acc']);
Scheduler::tick();
check('scheduler refuses an existing schedule on someone else\'s account (victim unchanged)', abs(bal($V['acc']) - $vb) < 0.001);
check('scheduler still runs the owner\'s own schedule (5.00 debited)', abs($mb - bal($M['acc']) - 5) < 0.001, (string) ($mb - bal($M['acc'])));

echo "[VAPT-04 brute force, VAPT-10 enumeration]\n";
$T = user('target');
for ($i = 0, $codes = []; $i < 6; $i++) $codes[] = call('POST', '/auth/login', ['email' => $T['email'], 'password' => "wrong-$i"])[0];
[$c] = call('POST', '/auth/login', ['email' => $T['email'], 'password' => $T['pw']]);
check('6th wrong password throttled (429) and the right one waits too', $codes[5] === 429 && $c === 429, json_encode($codes) . " then $c");
$ghost = 'ghost-' . bin2hex(random_bytes(3)) . '@sec.tensai.test';
for ($i = 0, $g = []; $i < 6; $i++) $g[] = call('POST', '/auth/login', ['email' => $ghost, 'password' => "x$i"])[0];
check('unknown identifier behaves the same (401 x5 then 429)', $g === [401, 401, 401, 401, 401, 429], json_encode($g));
$clearIp(); Db::run('DELETE FROM auth_failures WHERE identifier IN (:a, :b)', [':a' => strtolower($T['email']), ':b' => $ghost]);
[, $r1] = call('POST', '/auth/register', ['name' => 'x', 'email' => $T['email'], 'password' => 'Whatever-123', 'mobileNumber' => '6000000001']);
[, $r2] = call('POST', '/auth/register', ['name' => 'x', 'email' => 'fresh-' . bin2hex(random_bytes(3)) . '@x.test', 'password' => 'Whatever-123',
    'mobileNumber' => Db::one('SELECT mobile_number FROM users WHERE id = :u', [':u' => $T['id']])['mobileNumber']]);
check('registration does not say which field exists', ($r1['message'] ?? 'a') === ($r2['message'] ?? 'b') && !str_contains($r1['message'] ?? '', 'email'), json_encode([$r1, $r2]));
call('POST', '/auth/mpin', ['mpin' => '246810'], $T['tok']);
[$c1, $k1] = call('POST', '/auth/login', ['email' => $T['email'], 'mpin' => '000001']);
[$c2, $k2] = call('POST', '/auth/login', ['email' => 'nobody-' . bin2hex(random_bytes(3)) . '@sec.tensai.test', 'mpin' => '000001']);
check('wrong MPIN for a known user answers exactly like an unknown user', $c1 === $c2 && $k1 === $k2, json_encode([$c1, $k1, $c2, $k2]));
$clearIp();

echo "[VAPT-08 MPIN change, VAPT-09 sessions, VAPT-25 audit]\n";
[$c] = call('POST', '/auth/mpin', ['mpin' => '135791'], $T['tok']);
check('changing an existing MPIN without the current one is refused (401)', $c === 401, (string) $c);
[, $lr] = call('POST', '/auth/login', ['email' => $T['email'], 'password' => $T['pw']]); $other = $lr['token'];
[$c] = call('POST', '/auth/mpin', ['mpin' => '135791', 'currentMpin' => '246810'], $T['tok']);
check('changing it with the current MPIN works', $c === 200, (string) $c);
check('the other session ends after the MPIN change (401)', call('GET', '/accounts', null, $other)[0] === 401);
check('the session that made the change keeps working', call('GET', '/accounts', null, $T['tok'])[0] === 200);
[, $lr] = call('POST', '/auth/login', ['email' => $T['email'], 'password' => $T['pw']]); $other = $lr['token'];
[$c] = call('POST', '/profile/change-password', ['currentPassword' => $T['pw'], 'newPassword' => $T['pw'] . 'Z'], $T['tok']);
check('password change ends other sessions, keeps the current one', $c === 200 && call('GET', '/accounts', null, $other)[0] === 401
    && call('GET', '/accounts', null, $T['tok'])[0] === 200);
$ev = array_column(Db::all('SELECT event_type FROM audit_logs WHERE user_id = :u', [':u' => $T['id']]), 'eventType');
check('MPIN set/change and password change are audited', !array_diff(['auth.mpin_set', 'auth.mpin_changed', 'auth.password_changed'], $ev), json_encode($ev));
$N = user('newbie');
check('first-time MPIN setup still needs no current MPIN', call('POST', '/auth/mpin', ['mpin' => '112233'], $N['tok'])[0] === 200);

echo "[VAPT-07 idempotency, VAPT-18 amounts, VAPT-19 bills]\n";
$A = user('a'); $B = user('b');
$key = uuid();
[$c] = call('POST', '/transactions', ['fromAccount' => $A['acc'], 'toAccount' => $B['acc'], 'amount' => 12.34, 'idempotencyKey' => $key, 'description' => 'private'], $A['tok']);
check('legit internal transfer still works', $c === 201, (string) $c);
[$c, $r] = call('POST', '/transactions', ['fromAccount' => $B['acc'], 'toAccount' => $A['acc'], 'amount' => 1, 'idempotencyKey' => $key], $B['tok']);
check("another customer's key is refused without data (409)", $c === 409 && !isset($r['transaction']), "$c " . json_encode($r));
[$c] = call('POST', '/transactions', ['fromAccount' => $A['acc'], 'toAccount' => $B['acc'], 'amount' => 12.34, 'idempotencyKey' => $key], $A['tok']);
check('own replay still returns the original (200)', $c === 200, (string) $c);
[$c] = call('POST', '/transfer/quick', ['bankName' => 'HDFC Bank', 'accountNumber' => '123456789012', 'confirmAccountNumber' => '123456789012',
    'accountHolderName' => 'X', 'amount' => 1, 'sourceAccountId' => $B['acc'], 'idempotencyKey' => $key], $B['tok']);
check("another customer's key refused on external transfer (409)", $c === 409, (string) $c);
[$c] = call('POST', '/transactions', ['fromAccount' => $A['acc'], 'toAccount' => $B['acc'], 'amount' => 0.001, 'idempotencyKey' => uuid()], $A['tok']);
[$c2] = call('POST', '/transfer/quick', ['bankName' => 'HDFC Bank', 'accountNumber' => '123456789012', 'confirmAccountNumber' => '123456789012',
    'accountHolderName' => 'X', 'amount' => 0.004, 'sourceAccountId' => $A['acc'], 'idempotencyKey' => uuid()], $A['tok']);
check("sub-cent amounts refused ($c/$c2)", $c === 400 && $c2 === 400);
[, $br] = call('POST', '/bills', ['billerName' => 'SEC Water', 'category' => 'WATER', 'amount' => 10], $A['tok']);
[$c] = call('POST', '/bills/' . $br['bill']['id'] . '/pay', [], $A['tok']);
[$c2, $r2] = call('POST', '/bills/' . $br['bill']['id'] . '/pay', ['fromAccountId' => $A['acc']], $A['tok']);
check('bill without a source account stays unpaid (400); with one it is paid', $c === 400 && $c2 === 200 && ($r2['bill']['status'] ?? '') === 'PAID', "$c / $c2");

echo "[VAPT-13 headers, VAPT-14 CSV, VAPT-17 cookie, VAPT-21 IP, VAPT-15 chatbot]\n";
[, , $h] = call('GET', '/auth/me', null, $A['tok']);
check('security headers present, no X-Powered-By', stripos($h, 'X-Content-Type-Options: nosniff') !== false && stripos($h, "frame-ancestors 'none'") !== false
    && stripos($h, 'Cache-Control: no-store') !== false && stripos($h, 'X-Powered-By') === false, $h);
Db::run("UPDATE transactions SET description = :d WHERE idempotency_key = :k", [':d' => '=HYPERLINK("http://example.invalid","x")', ':k' => $key]);
$ch = curl_init("$base/transactions/statement.csv"); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ["Authorization: Bearer {$A['tok']}"]]);
$csv = (string) curl_exec($ch);
check('statement neutralises formula cells', str_contains($csv, "\"'=HYPERLINK") && !preg_match('/(^|,)"?=HYPERLINK/m', $csv));
[, , $h] = call('POST', '/auth/login', ['email' => $A['email'], 'password' => $A['pw']], null, ['X-Forwarded-Proto: https', 'X-Forwarded-For: 203.0.113.9']);
check('auth cookie is Secure behind HTTPS', (bool) preg_match('/Set-Cookie: token=[^\r\n]*Secure/i', $h));
$ip = Db::one("SELECT ip FROM login_events WHERE user_id = :u ORDER BY id DESC LIMIT 1", [':u' => $A['id']])['ip'] ?? '';
check('login audit ignores X-Forwarded-For', $ip !== '203.0.113.9' && $ip !== '', $ip);
for ($i = 0, $last = 0; $i < 31; $i++) $last = call('POST', '/chatbot/message', ['message' => 'hi'], $A['tok'])[0];
check('chatbot limited to 30 per minute across requests (31st -> 429)', $last === 429, (string) $last);

$clearIp();
echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
