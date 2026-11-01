<?php
// Journey telemetry check (0008). Creates test users — local/staging only.
//   php tests/journeys.php --base=http://127.0.0.1:8090 --allow-writes
require __DIR__ . '/../src/bootstrap.php';
use Tensai\Db;

$opt = getopt('', ['base:', 'allow-writes']);
if (!isset($opt['allow-writes'])) exit("refusing to run without --allow-writes (creates users)\n");
$base = rtrim($opt['base'] ?? 'http://127.0.0.1:8090', '/') . '/api';
$pass = $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void {
    global $pass, $fail; $ok ? $pass++ : $fail++;
    echo ($ok ? '  PASS ' : '  FAIL ') . $name . ($ok || !$detail ? '' : "  -> $detail") . "\n";
}
function call(string $m, string $path, ?array $body = null, ?string $tok = null, array $h = []): array {
    global $base;
    $ch = curl_init($base . $path);
    $hdr = array_merge(['Content-Type: application/json', 'User-Agent: Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36'], $h);
    if ($tok) $hdr[] = "Authorization: Bearer $tok";
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $m, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $hdr,
        CURLOPT_POSTFIELDS => $body === null ? null : json_encode($body)]);
    $out = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    return [$code, json_decode((string) $out, true) ?? []];
}
function uuid(): string { $h = bin2hex(random_bytes(16)); return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-4' . substr($h, 13, 3) . '-a' . substr($h, 17, 3) . '-' . substr($h, 20, 12); }
function events(string $jid): array { return Db::all('SELECT * FROM journey_events WHERE journey_id = :j ORDER BY id', [':j' => $jid]); }

$run = time() . random_int(100, 999);
$email = "journey-$run@test.invalid";
[$c, $reg] = call('POST', '/auth/register', ['name' => 'Journey Tester', 'email' => $email, 'password' => 'Journey-Pass-1', 'mobileNumber' => '5' . substr($run, -9)]);
check('register 201', $c === 201, (string) $c);
$tok = $reg['token'] ?? '';
$uid = $reg['user']['id'] ?? '';
$u = Db::one('SELECT segment, home_branch_id FROM users WHERE id = :u', [':u' => $uid]);
check('new user gets segment + home branch at insert (trigger)', in_array($u['segment'] ?? null, ['retail', 'premier', 'sme'], true)
    && preg_match('/^BR-0[0-4][0-9]$/', (string) ($u['homeBranchId'] ?? '')), json_encode($u));

[$c] = call('POST', '/auth/login', ['email' => $email, 'password' => 'Journey-Pass-1']);
$login = Db::one("SELECT * FROM journey_events WHERE user_id = :u AND journey = 'login' ORDER BY id DESC LIMIT 1", [':u' => $uid]);
check('login success -> login/sign_in completed', ($login['status'] ?? null) === 'completed' && $login['outcome'] === 'success');
call('POST', '/auth/login', ['email' => $email, 'password' => 'wrong-password']);
$bad = Db::one("SELECT * FROM journey_events WHERE user_id = :u AND journey = 'login' ORDER BY id DESC LIMIT 1", [':u' => $uid]);
check('bad login -> failed / invalid_credentials / user', ($bad['status'] ?? '') === 'failed'
    && $bad['reasonCode'] === 'invalid_credentials' && $bad['failureClass'] === 'user');

// Bill pay: UI steps via /journey/step, then the server confirm step, same journey id.
$accs = call('GET', '/accounts', null, $tok)[1]['accounts'] ?? [];
$acc = $accs[0]['id'] ?? null;
[, $bill] = call('POST', '/bills', ['billerName' => 'Journey Power', 'category' => 'ELECTRICITY', 'amount' => 10_000_000], $tok);
$billId = $bill['bill']['id'] ?? '';
$jid = uuid();
foreach (['sign_in', 'choose_biller', 'enter_amount'] as $s)
    call('POST', '/journey/step', ['journeyId' => $jid, 'journey' => 'bill_pay', 'step' => $s], $tok);
[$c] = call('POST', '/journey/step', ['journeyId' => $jid, 'journey' => 'bill_pay', 'step' => 'receipt'], $tok);
check('client cannot record a final step', $c === 400, (string) $c);
[$c] = call('POST', "/bills/$billId/pay", ['fromAccountId' => $acc], $tok, ["X-Journey-Id: $jid"]);
$ev = events($jid);
$last = end($ev);
check('insufficient funds bill pay -> 4 steps, last failed/business', count($ev) === 4 && $last['step'] === 'confirm_payment'
    && $last['reasonCode'] === 'insufficient_funds' && $last['failureClass'] === 'business', json_encode(array_column($ev, 'step')) . " http $c");
check('first step status started, amount carried from attempt', $ev[0]['status'] === 'started' && (float) $last['amount'] === 10000000.0);
check('journey duration on terminal event', $last['journeyDurationMs'] !== null);
check('device/browser/channel parsed', $last['device'] === 'desktop' && $last['browser'] === 'Chrome' && $last['channel'] === 'web');

// Successful bill pay emits confirm_payment + receipt (completed).
[, $b2] = call('POST', '/bills', ['billerName' => 'Journey Water', 'category' => 'WATER', 'amount' => 1], $tok);
$jid2 = uuid();
[$c, $paid] = call('POST', '/bills/' . ($b2['bill']['id'] ?? '') . '/pay', [], $tok, ["X-Journey-Id: $jid2", 'X-Channel: partner_api']);
$ev2 = events($jid2);
check('successful bill pay -> confirm_payment + receipt completed', $c === 200 && array_column($ev2, 'step') === ['confirm_payment', 'receipt']
    && end($ev2)['status'] === 'completed', "http $c " . json_encode(array_column($ev2, 'step')));
check('X-Channel honoured', ($ev2[0]['channel'] ?? '') === 'partner_api');

// Card payment + controls + dispute (new minimal endpoints).
[, $card] = call('POST', '/cards', ['accountId' => $acc], $tok);
$cardId = $card['card']['id'] ?? '';
[$c, $cp] = call('POST', "/cards/$cardId/pay", ['amount' => 1, 'merchant' => 'Coffee'], $tok);
$funded = $c === 201;
check('card payment answers 201 or 400 insufficient (new account may be empty)', in_array($c, [201, 400], true), (string) $c);
check('card payment attempt recorded with kind CARD', (bool) Db::one("SELECT 1 FROM transaction_attempts WHERE user_id=:u AND kind='CARD'", [':u' => $uid]));
check('card_payment/authorize event recorded', (bool) Db::one("SELECT 1 FROM journey_events WHERE user_id=:u AND journey='card_payment'", [':u' => $uid]));
call('POST', "/cards/$cardId/freeze", null, $tok);
[$c] = call('POST', "/cards/$cardId/pay", ['amount' => 1], $tok);
check('frozen card is declined 403', $c === 403, (string) $c);
check('card_controls/change_control completed', (bool) Db::one("SELECT 1 FROM journey_events WHERE user_id=:u AND journey='card_controls' AND status='completed'", [':u' => $uid]));

$txId = $funded ? ($cp['transaction']['id'] ?? null) : Db::one('SELECT t.id FROM transactions t JOIN accounts a ON a.id IN (t.from_account_id,t.to_account_id) WHERE a.user_id=:u LIMIT 1', [':u' => $uid])['id'] ?? null;
if ($txId) {
    [$c] = call('POST', '/disputes', ['transactionId' => $txId, 'reason' => 'Not recognised'], $tok);
    check('dispute created 201', $c === 201, (string) $c);
    [$c] = call('POST', '/disputes', ['transactionId' => $txId, 'reason' => 'Not recognised'], $tok);
    check('second open dispute on same transaction 409', $c === 409, (string) $c);
} else {
    echo "  SKIP dispute (no transaction on the new account)\n";
}
[$c] = call('POST', '/disputes', ['transactionId' => uuid(), 'reason' => 'Someone else\'s'], $tok);
check('dispute on a foreign/unknown transaction 404', $c === 404, (string) $c);

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
