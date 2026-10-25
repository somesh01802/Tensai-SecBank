<?php
/**
 * Synthetic user-journey generator. Drives REAL HTTP requests through Apache →
 * php-fpm (the actual application services), so every request is traced by the
 * Elastic APM PHP agent and every attempt lands in Postgres → the existing
 * Kibana indices. CLI APM is off, so this script itself emits no telemetry.
 *
 * Safety:
 *  - Uses only its own pool of SYNTHETIC users (w<W>-u<NNN>@loadtest.tensai.test).
 *    The server flags them is_synthetic from the reserved domain; every event they
 *    produce is classified synthetic in APM and in Kibana.
 *  - The server refuses transfers between synthetic and live accounts, so test
 *    money never touches real customers. External transfers are ledger-only
 *    (the app has no connection to real payment rails).
 *  - Infrastructure failures (processor/fraud timeouts, network, DB concurrency,
 *    outages) are requested via X-Tensai-Fault; the server honours it ONLY for
 *    synthetic users with FAULT_INJECTION_ENABLED=true, and BEFORE any ledger write.
 *  - Every attempt has a unique idempotency key; deliberate duplicate re-sends
 *    verify the server never double-posts.
 *
 *   php bin/traffic.php [--base=http://127.0.0.1] [--users=20] [--minutes=10] [--worker=1]
 *                       [--rps=1] [--think-ms=150] [--fail-rate=0.15] [--faults=all|cat1,cat2]
 *                       [--seed=N] [--transfer-limit=500000] [--verbose]
 *   php bin/traffic.php --stop     immediate stop: every worker exits before its next request
 *   php bin/traffic.php --resume   allow workers to run again
 *
 * --rps caps requests/second per worker; --seed makes the sequence of decisions
 * repeatable (idempotency keys stay unique). Failure categories:
 *   insufficient_funds invalid_beneficiary transfer_limit (real validation paths)
 *   processor_timeout network_failure fraud_timeout db_concurrency service_outage (injected)
 */

// In the system temp dir so the switch works whoever runs the workers (www-data) or sets it (root).
define('STOP_FILE', getenv('TRAFFIC_STOP_FILE') ?: sys_get_temp_dir() . '/tensai-traffic.stop');
const STOPPED_EXIT = 75; // systemd unit: RestartPreventExitStatus=75
const PASSWORD = 'LoadTest-2026!';
const REAL_FAILURES = ['insufficient_funds', 'invalid_beneficiary', 'transfer_limit'];
const INJECTED_FAILURES = ['processor_timeout', 'network_failure', 'fraud_timeout', 'db_concurrency', 'service_outage'];

$o = getopt('', ['base::', 'users::', 'minutes::', 'worker::', 'rps::', 'think-ms::', 'fail-rate::', 'faults::',
    'seed::', 'transfer-limit::', 'verbose', 'stop', 'resume']);
if (isset($o['stop'])) { touch(STOP_FILE); @chmod(STOP_FILE, 0644); echo "[traffic] stop requested (" . STOP_FILE . ") — workers exit before their next request\n"; exit(0); }
if (isset($o['resume'])) { @unlink(STOP_FILE); echo "[traffic] resumed\n"; exit(0); }

$BASE    = rtrim($o['base'] ?? 'http://127.0.0.1', '/');
$USERS   = max(1, (int) ($o['users'] ?? 20));
$MINUTES = (float) ($o['minutes'] ?? 10);
$W       = max(1, (int) ($o['worker'] ?? 1));
$RPS     = max(0.0, (float) ($o['rps'] ?? 1));
$THINK   = max(0, (int) ($o['think-ms'] ?? 150));
$FAIL    = min(1.0, max(0.0, (float) ($o['fail-rate'] ?? 0.15)));
$LIMIT   = (float) ($o['transfer-limit'] ?? 500000);
$VERBOSE = isset($o['verbose']);
$FAULTS  = ($o['faults'] ?? 'all') === 'all' ? [...REAL_FAILURES, ...INJECTED_FAILURES]
    : array_values(array_intersect(array_map('trim', explode(',', $o['faults'])), [...REAL_FAILURES, ...INJECTED_FAILURES]));
if (!$FAULTS) { fwrite(STDERR, "--faults: no valid categories\n"); exit(2); }
mt_srand(isset($o['seed']) ? (int) $o['seed'] + $W : random_int(1, PHP_INT_MAX));

$stats = ['2xx' => 0, '4xx' => 0, '5xx' => 0, 'neterr' => 0, 'attempts' => 0, 'ok' => 0, 'feedback' => 0,
    'dup_blocked' => 0, 'dup_violations' => 0];
$byCategory = [];
$IP = '10.0.0.1';
$SESSION = null;

function chance(float $p): bool { return mt_rand() / mt_getrandmax() < $p; }
function pick(array $a) { return $a[mt_rand(0, count($a) - 1)]; }
function weighted(array $w): string
{
    $r = mt_rand() / mt_getrandmax() * array_sum($w);
    foreach ($w as $k => $v) { if (($r -= $v) <= 0) return $k; }
    return array_key_last($w);
}

function uuid(): string // CSPRNG, independent of --seed: keys are always unique
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

function personName(string $seed): string
{
    static $first = ['Aarav', 'Vivaan', 'Aditya', 'Ananya', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Priya', 'Arjun',
        'Meera', 'Kabir', 'Saanvi', 'Vihaan', 'Riya', 'Aryan', 'Neha', 'Karan', 'Pooja', 'Rahul'];
    static $last = ['Sharma', 'Verma', 'Iyer', 'Reddy', 'Patel', 'Gupta', 'Nair', 'Menon', 'Singh', 'Kumar',
        'Das', 'Joshi', 'Rao', 'Mehta', 'Kapoor', 'Bose', 'Pillai', 'Shah', 'Chopra', 'Malhotra'];
    $h = crc32($seed);
    return $first[$h % count($first)] . ' ' . $last[intdiv($h, 97) % count($last)];
}

function mobile(string $key, int $attempt): string
{
    return '6' . str_pad((string) (crc32("$key#$attempt") % 1000000000), 9, '0', STR_PAD_LEFT);
}

/** One HTTP call. Rate-limited (--rps) and honours the stop switch. Returns [status, json]. */
function call(string $method, string $path, ?array $body = null, ?string $token = null, array $headers = []): array
{
    global $BASE, $stats, $THINK, $RPS, $IP, $SESSION, $VERBOSE;
    static $last = 0.0;
    if (is_file(STOP_FILE)) { report(); echo "[traffic] stop switch present — exiting\n"; exit(STOPPED_EXIT); }
    if ($RPS > 0) { $wait = $last + 1 / $RPS - microtime(true); if ($wait > 0) usleep((int) ($wait * 1e6)); }
    $last = microtime(true);

    $h = ['Accept: application/json', 'User-Agent: tensai-traffic-gen/2.0', 'X-Forwarded-For: ' . $IP];
    if ($SESSION) $h[] = 'X-Session-Id: ' . $SESSION;
    if ($body !== null) $h[] = 'Content-Type: application/json';
    if ($token) $h[] = 'Authorization: Bearer ' . $token;
    $ch = curl_init($BASE . '/api' . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array_merge($h, $headers), CURLOPT_TIMEOUT => 30]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false || $code === 0) $stats['neterr']++;
    else $stats[intdiv($code, 100) . 'xx'] = ($stats[intdiv($code, 100) . 'xx'] ?? 0) + 1;
    $json = is_string($raw) ? (json_decode($raw, true) ?: []) : [];
    if ($VERBOSE && ($code < 200 || $code >= 300))
        printf("  %-6s %-34s → %d %s%s\n", $method, strtok($path, '?'), $code, $json['message'] ?? '',
            isset($json['errorCategory']) ? " [{$json['errorCategory']}]" : '');
    if ($THINK > 0) usleep(mt_rand(intdiv($THINK, 2), $THINK + intdiv($THINK, 2)) * 1000);
    return [$code, $json];
}

/** Log in (registering on first use); new X-Session-Id per login; honest location outcome. */
function login(array &$u): bool
{
    global $FAIL, $SESSION;
    $SESSION = $u['session'] = uuid();
    if (chance($FAIL / 2)) call('POST', '/auth/login', ['email' => $u['email'], 'password' => 'wrong-' . mt_rand(1, 999)]);

    [$c, $j] = call('POST', '/auth/login', ['email' => $u['email'], 'password' => PASSWORD]);
    if ($c === 401) {
        for ($a = 0; $a < 5 && $c !== 201; $a++)
            [$c, $j] = call('POST', '/auth/register', ['name' => $u['name'], 'email' => $u['email'],
                'password' => PASSWORD, 'mobileNumber' => mobile($u['key'], $a)]);
        if ($c !== 201) return false;
    } elseif ($c !== 200) {
        return false;
    }
    $u['token'] = $j['token'] ?? null;
    // A script has no browser geolocation: report that honestly — never invent coordinates.
    if ($u['token'] && !empty($j['loginEventId']))
        call('POST', '/auth/location', ['loginEventId' => $j['loginEventId'], 'status' => 'unavailable'], $u['token']);
    return (bool) $u['token'];
}

/** Record the attempt outcome and (usually) leave feedback for it. */
function settle(array $u, int $code, array $json, ?string $intended): void
{
    global $stats, $byCategory;
    $stats['attempts']++;
    $ok = $code >= 200 && $code < 300;
    if ($ok) $stats['ok']++;
    else { $cat = $json['errorCategory'] ?? "http_$code"; $byCategory[$cat] = ($byCategory[$cat] ?? 0) + 1; }
    if ($intended && $ok) $byCategory["UNEXPECTED_SUCCESS:$intended"] = ($byCategory["UNEXPECTED_SUCCESS:$intended"] ?? 0) + 1;

    $attemptId = $json['attemptId'] ?? null;
    if (!$attemptId || chance(0.15)) return;           // ~15% ignore the prompt
    if (chance(0.25)) { $body = ['attemptId' => $attemptId, 'dismissed' => true]; }
    else {
        $rating = $ok ? weighted(['HAPPY' => 6, 'SATISFIED' => 3, 'NOT_SATISFIED' => 1])
                      : weighted(['HAPPY' => 0.3, 'SATISFIED' => 1.7, 'NOT_SATISFIED' => 8]);
        $comments = ['NOT_SATISFIED' => ['Payment failed twice', 'Too slow', 'Error message was unclear'],
                     'SATISFIED' => ['OK', 'Worked, a bit slow'], 'HAPPY' => ['Quick and easy', 'Great app']];
        $body = ['attemptId' => $attemptId, 'rating' => $rating] + (chance(0.3) ? ['comment' => pick($comments[$rating])] : []);
    }
    [$c] = call('POST', '/feedback', $body, $u['token']);
    if ($c === 201) $stats['feedback']++;
    if ($c === 201 && chance(0.03)) { // a double-tap must be rejected
        [$c2] = call('POST', '/feedback', $body, $u['token']);
        $c2 === 409 ? $stats['dup_blocked']++ : $stats['dup_violations']++;
    }
}

/** Decide whether this attempt should fail, and how. */
function failureMode(): ?string
{
    global $FAIL, $FAULTS;
    return chance($FAIL) ? pick($FAULTS) : null;
}

function journey(int $i): void
{
    global $POOL, $LIMIT, $stats;
    static $banks = null;
    $u = &$POOL[$i];
    $t = $u['token'];

    call('GET', '/auth/me', null, $t);
    [, $d] = call('GET', '/accounts', null, $t);
    $balance = 0.0;
    foreach ($d['accounts'] ?? [] as $a) if (!empty($a['isPrimary'])) { $u['accountId'] = $a['id']; $balance = (float) ($a['balance'] ?? 0); }
    call('GET', '/dashboard/summary', null, $t);
    $browse = ['/transactions?limit=50', '/notifications', '/bills', '/cards', '/card-products', '/investments',
        '/loans/products', '/rewards', '/statistics', '/payees', '/profile'];
    shuffle($browse);
    foreach (array_slice($browse, 0, mt_rand(2, 5)) as $p) call('GET', $p, null, $t);
    $src = $u['accountId'] ?? null;
    if (!$src) return;

    $mode = failureMode();
    $headers = in_array($mode, INJECTED_FAILURES, true) ? ['X-Tensai-Fault: ' . $mode] : [];
    $amount = mt_rand(5, 400);
    if ($mode === 'insufficient_funds') $amount = min($LIMIT, $balance + mt_rand(1, 5000));
    if ($mode === 'transfer_limit') $amount = $LIMIT + mt_rand(1, 100000);
    $kind = weighted(['P2P' => 5, 'EXTERNAL' => 3, 'BILL' => 2]);
    if ($mode === 'transfer_limit' && $kind === 'BILL') $kind = 'P2P'; // limits apply to transfers

    if ($kind === 'P2P') {
        $peer = $POOL[array_rand($POOL)];
        if (empty($peer['accountId']) || $peer['accountId'] === $src) return;
        $body = ['fromAccount' => $src, 'toAccount' => $mode === 'invalid_beneficiary' ? uuid() : $peer['accountId'],
            'amount' => $amount, 'idempotencyKey' => uuid(), 'description' => 'P2P to ' . $peer['name']];
        [$c, $j] = call('POST', '/transactions', $body, $t, $headers);
        settle($u, $c, $j, $mode);
        if ($c === 201 && chance(0.05)) { // network-retry with the SAME key must not double-post
            [$c2, $j2] = call('POST', '/transactions', $body, $t);
            ($c2 === 200 && ($j2['transaction']['id'] ?? null) === ($j['transaction']['id'] ?? 'x'))
                ? $stats['dup_blocked']++ : $stats['dup_violations']++;
        }
    } elseif ($kind === 'EXTERNAL') {
        $banks ??= call('GET', '/payees/banks', null, $t)[1]['banks'] ?? ['HDFC Bank'];
        $acct = (string) mt_rand(100000000, 999999999) . mt_rand(100, 999);
        [$c, $j] = call('POST', '/transfer/quick', [
            'bankName' => pick($banks), 'accountNumber' => $acct,
            'confirmAccountNumber' => $mode === 'invalid_beneficiary' ? strrev($acct) . '1' : $acct,
            'accountHolderName' => personName(uuid()), 'amount' => $amount, 'remarks' => 'Payment',
            'sourceAccountId' => $src, 'idempotencyKey' => uuid(),
        ], $t, $headers);
        settle($u, $c, $j, $mode);
    } else { // BILL
        $billers = [['Tata Power', 'ELECTRICITY'], ['Airtel Postpaid', 'MOBILE'], ['Jio Fiber', 'BROADBAND'],
            ['Mahanagar Gas', 'GAS'], ['Netflix', 'SUBSCRIPTION']];
        [$name, $cat] = pick($billers);
        [$c, $j] = call('POST', '/bills', ['billerName' => $name, 'category' => $cat, 'amount' => $amount,
            'dueDate' => date('Y-m-d', strtotime('+' . mt_rand(1, 20) . ' days'))], $t);
        if ($c !== 201 || empty($j['bill']['id'])) return;
        $billId = $mode === 'invalid_beneficiary' ? uuid() : $j['bill']['id'];
        [$c, $j] = call('POST', "/bills/$billId/pay", ['fromAccountId' => $src], $t, $headers);
        settle($u, $c, $j, $mode);
    }
}

function report(): void
{
    global $W, $stats, $byCategory, $iter;
    $cats = $byCategory ? implode(' ', array_map(fn($k, $v) => "$k=$v", array_keys($byCategory), $byCategory)) : '-';
    printf("[w%d] %s sessions=%d http 2xx=%d 4xx=%d 5xx=%d neterr=%d | attempts=%d ok=%d feedback=%d dup_blocked=%d dup_violations=%d | failures: %s\n",
        $W, date('H:i:s'), $iter, $stats['2xx'], $stats['4xx'], $stats['5xx'], $stats['neterr'],
        $stats['attempts'], $stats['ok'], $stats['feedback'], $stats['dup_blocked'], $stats['dup_violations'], $cats);
}

$POOL = [];
for ($n = 1; $n <= $USERS; $n++) {
    $key = "w$W-u$n";
    $POOL[] = ['key' => $key, 'email' => sprintf('w%d-u%03d@loadtest.tensai.test', $W, $n), 'name' => personName($key),
        'token' => null, 'session' => null, 'accountId' => null, 'ip' => sprintf('10.%d.%d.%d', $W % 256, intdiv($n, 256) % 256, $n % 256)];
}

echo "[w$W] synthetic traffic → $BASE for {$MINUTES} min, {$USERS} users, rps≤{$RPS}, fail-rate {$FAIL}, faults: "
    . implode(',', $FAULTS) . "\n";
$end = microtime(true) + $MINUTES * 60;
$iter = 0; $lastReport = time();
while (microtime(true) < $end) {
    $i = array_rand($POOL);
    $IP = $POOL[$i]['ip'];
    $SESSION = $POOL[$i]['session'];
    if (!$POOL[$i]['token'] && !login($POOL[$i])) continue;
    journey($i);
    if (chance(0.3)) { call('POST', '/auth/logout', null, $POOL[$i]['token']); $POOL[$i]['token'] = $POOL[$i]['session'] = null; }
    $iter++;
    if (time() - $lastReport >= 15) { report(); $lastReport = time(); }
}
report();
