<?php
/**
 * Synthetic traffic generator. Drives REAL HTTP requests through Apache →
 * php-fpm so the Elastic APM PHP agent records every one (CLI APM is off, so
 * this script itself emits no telemetry). Walks every journey — login,
 * dashboard, accounts, transactions, transfers, bills, cards, investments,
 * loans, autopay, rewards, statement — and deliberately mixes in failures:
 * wrong password, unknown user, insufficient balance, invalid account,
 * mismatched account number, unknown loan product, out-of-range tenure.
 *
 * Uses its own pool of load-test users (w<W>-u<NNN>@loadtest.tensai.test,
 * password below), registering them on first use. Real users' data and
 * balances are never touched.
 *
 *   php bin/traffic.php [--base=http://127.0.0.1] [--users=20] [--minutes=10]
 *                       [--worker=1] [--think-ms=150] [--fail-rate=0.15] [--verbose]
 *   --verbose prints every non-2xx call with the API's message.
 *
 * More load = more workers in parallel (each gets its own user pool):
 *   for w in 1 2 3 4; do php bin/traffic.php --worker=$w --minutes=30 & done; wait
 */

$o = getopt('', ['base::', 'users::', 'minutes::', 'worker::', 'think-ms::', 'fail-rate::', 'verbose']);
$VERBOSE = isset($o['verbose']);
$BASE    = rtrim($o['base'] ?? 'http://127.0.0.1', '/');
$USERS   = max(1, (int) ($o['users'] ?? 20));
$MINUTES = (float) ($o['minutes'] ?? 10);
$W       = max(1, (int) ($o['worker'] ?? 1));
$THINK   = max(0, (int) ($o['think-ms'] ?? 150));
$FAIL    = min(1.0, max(0.0, (float) ($o['fail-rate'] ?? 0.15)));
const PASSWORD = 'LoadTest-2026!';

$stats = ['2xx' => 0, '3xx' => 0, '4xx' => 0, '5xx' => 0, 'neterr' => 0];
$IP = '10.0.0.1';

function chance(float $p): bool { return mt_rand() / mt_getrandmax() < $p; }

function uuid(): string
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

/** Deterministic 10-digit mobile per user; $attempt varies it on a collision. */
function mobile(string $key, int $attempt): string
{
    return '6' . str_pad((string) (crc32("$key#$attempt") % 1000000000), 9, '0', STR_PAD_LEFT);
}

/** One HTTP call to the API. Returns [status, decoded JSON]. */
function call(string $method, string $path, ?array $body = null, ?string $token = null): array
{
    global $BASE, $stats, $THINK, $IP;
    $h = ['Accept: application/json', 'User-Agent: tensai-traffic-gen/1.0', 'X-Forwarded-For: ' . $IP];
    if ($body !== null) $h[] = 'Content-Type: application/json';
    if ($token) $h[] = 'Authorization: Bearer ' . $token;
    $ch = curl_init($BASE . '/api' . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 30]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false || $code === 0) $stats['neterr']++;
    else $stats[intdiv($code, 100) . 'xx'] = ($stats[intdiv($code, 100) . 'xx'] ?? 0) + 1;
    $json = is_string($raw) ? (json_decode($raw, true) ?: []) : [];
    if ($GLOBALS['VERBOSE'] && ($code < 200 || $code >= 300))
        printf("  %-6s %-40s → %d %s\n", $method, strtok($path, '?'), $code, $json['message'] ?? '');
    if ($THINK > 0) usleep(random_int(intdiv($THINK, 2), $THINK + intdiv($THINK, 2)) * 1000);
    return [$code, $json];
}

/** Log a pool user in (registering on first use), with injected login failures. */
function login(array &$u): bool
{
    global $FAIL;
    if (chance($FAIL)) call('POST', '/auth/login', ['email' => $u['email'], 'password' => 'wrong-' . random_int(1, 999)]);
    if (chance($FAIL / 3)) call('POST', '/auth/login', ['email' => 'nobody' . random_int(1, 99999) . '@loadtest.tensai.test', 'password' => 'x']);

    [$c, $j] = call('POST', '/auth/login', ['email' => $u['email'], 'password' => PASSWORD]);
    if ($c === 401) { // not registered yet
        for ($a = 0; $a < 5 && $c !== 201; $a++) {
            [$c, $j] = call('POST', '/auth/register', ['name' => $u['name'], 'email' => $u['email'],
                'password' => PASSWORD, 'mobileNumber' => mobile($u['key'], $a)]);
        }
        if ($c !== 201) return false;
    } elseif ($c !== 200) {
        return false;
    }
    $u['token'] = $j['token'] ?? null;
    return (bool) $u['token'];
}

/** One browsing + transacting session for pool user $i. */
function journey(int $i): void
{
    global $POOL, $FAIL;
    static $banks = null, $products = null;
    $u = &$POOL[$i];
    $t = $u['token'];

    call('GET', '/auth/me', null, $t);
    [, $d] = call('GET', '/accounts', null, $t);
    foreach ($d['accounts'] ?? [] as $a) if (!empty($a['isPrimary'])) $u['accountId'] = $a['id'];
    $u['accountId'] ??= $d['accounts'][0]['id'] ?? null;
    call('GET', '/dashboard/summary', null, $t);

    $browse = ['/transactions?limit=50', '/notifications', '/bills', '/investments', '/cards', '/autopay',
        '/autopay/history', '/loans/products', '/loans/applications', '/rewards', '/statistics',
        '/card-products', '/payees', '/beneficiaries', '/recurring-bills', '/transfer/scheduled',
        '/profile', '/account-applications'];
    shuffle($browse);
    foreach (array_slice($browse, 0, random_int(3, 7)) as $p) call('GET', $p, null, $t);

    $pages = ['dashboard', 'bills', 'cards', 'investments', 'loans', 'rewards', 'notifications', 'overview', 'manage_account'];
    call('POST', '/rewards/event', ['condition' => 'page.visited.' . $pages[array_rand($pages)]], $t);

    $src = $u['accountId'] ?? null;
    if (!$src) return;

    // Internal P2P transfer to another pool user (failures: huge amount, unknown account).
    $peer = $POOL[array_rand($POOL)];
    if (!empty($peer['accountId']) && $peer['accountId'] !== $src) {
        call('POST', '/transactions', [
            'fromAccount' => $src,
            'toAccount' => chance($FAIL / 2) ? uuid() : $peer['accountId'],
            'amount' => chance($FAIL) ? 50000000 : random_int(5, 500),
            'idempotencyKey' => uuid(),
            'description' => 'P2P to ' . $peer['name'],
        ], $t);
    }

    // External quick transfer (failures: mismatched account number, insufficient balance).
    if (chance(0.5)) {
        $banks ??= call('GET', '/payees/banks', null, $t)[1]['banks'] ?? ['HDFC Bank'];
        $acct = (string) random_int(100000000000, 999999999999);
        call('POST', '/transfer/quick', [
            'bankName' => $banks[array_rand($banks)], 'accountNumber' => $acct,
            'confirmAccountNumber' => chance($FAIL) ? strrev($acct) . '1' : $acct,
            'accountHolderName' => personName(uuid()),
            'amount' => chance($FAIL) ? 90000000 : random_int(10, 300),
            'remarks' => 'Payment', 'sourceAccountId' => $src, 'idempotencyKey' => uuid(),
        ], $t);
    }

    // Add + pay a bill.
    if (chance(0.3)) {
        $billers = [['Tata Power', 'ELECTRICITY'], ['Airtel Postpaid', 'MOBILE'], ['Jio Fiber', 'BROADBAND'],
            ['Mahanagar Gas', 'GAS'], ['Netflix', 'SUBSCRIPTION']];
        [$name, $cat] = $billers[array_rand($billers)];
        [$c, $j] = call('POST', '/bills', ['billerName' => $name, 'category' => $cat, 'amount' => random_int(10, 150),
            'dueDate' => date('Y-m-d', strtotime('+' . random_int(1, 20) . ' days'))], $t);
        if ($c === 201 && !empty($j['bill']['id']) && chance(0.8))
            call('POST', '/bills/' . $j['bill']['id'] . '/pay', ['fromAccountId' => $src], $t);
    }

    // Loan EMI calculation (failures: unknown product, tenure out of range).
    if (chance(0.25)) {
        $products ??= call('GET', '/loans/products', null, $t)[1]['products'] ?? [];
        if ($products) {
            $p = $products[array_rand($products)];
            $min = (int) $p['minAmount'];
            call('POST', '/loans/calculate', [
                'productCode' => chance($FAIL / 2) ? 'NO_SUCH_PRODUCT' : $p['code'],
                'principal' => random_int($min, (int) min((float) $p['maxAmount'], $min * 5)),
                'tenureMonths' => chance($FAIL / 2) ? (int) $p['maxTenure'] + 12 : random_int((int) $p['minTenure'], (int) $p['maxTenure']),
            ], $t);
        }
    }

    if (chance(0.10)) {
        $types = ['MUTUAL_FUND', 'FIXED_DEPOSIT', 'STOCKS', 'RECURRING_DEPOSIT'];
        call('POST', '/investments', ['type' => $types[array_rand($types)], 'name' => 'SIP ' . random_int(1, 99),
            'investedAmount' => random_int(500, 5000)], $t);
    }
    if (chance(0.10)) call('GET', '/accounts/' . uuid() . '/detail', null, $t); // invalid account → 404
    if (chance(0.05)) call('GET', '/transactions/statement.csv', null, $t);
}

function report(): void
{
    global $W, $stats, $iter;
    printf("[w%d] %s sessions=%d 2xx=%d 4xx=%d 5xx=%d neterr=%d\n", $W, date('H:i:s'), $iter,
        $stats['2xx'], $stats['4xx'], $stats['5xx'], $stats['neterr']);
}

$POOL = [];
for ($n = 1; $n <= $USERS; $n++) {
    $key = "w$W-u$n";
    $POOL[] = ['key' => $key, 'email' => sprintf('w%d-u%03d@loadtest.tensai.test', $W, $n), 'name' => personName($key),
        'token' => null, 'accountId' => null, 'ip' => sprintf('10.%d.%d.%d', $W % 256, intdiv($n, 256) % 256, $n % 256)];
}

echo "[w$W] traffic → $BASE for {$MINUTES} min, {$USERS} users, fail-rate {$FAIL}\n";
$end = microtime(true) + $MINUTES * 60;
$iter = 0; $last = time();
while (microtime(true) < $end) {
    $i = array_rand($POOL);
    $IP = $POOL[$i]['ip'];
    if (!$POOL[$i]['token'] && !login($POOL[$i])) continue;
    journey($i);
    if (chance(0.3)) { // log out so the next session logs in again (login count grows)
        call('POST', '/auth/logout', null, $POOL[$i]['token']);
        $POOL[$i]['token'] = null;
    }
    $iter++;
    if (time() - $last >= 15) { report(); $last = time(); }
}
report();
