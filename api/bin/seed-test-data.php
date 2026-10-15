<?php
/**
 * Synthetic test-data seeder for Tensai SecBank (PHP port — no OpenTelemetry).
 *
 * Generates N synthetic users (default 5000) that log in through the real app
 * (email+password OR mobile+MPIN), each with realistic banking data and a mix
 * of successful + failed transactions. All records tagged [SYNTHETIC].
 *
 * SAFE: never logs passwords/MPINs; writes a gitignored credential manifest.
 * IDEMPOTENT: users keyed by deterministic email; rerun skips existing.
 *
 * Config (env):
 *   DATABASE_URL            required
 *   SEED_USERS=5000         how many synthetic users
 *   SEED_TX_PER_USER=8      transactions per user
 *   SEED_PREFIX=tuser       email namespace -> <prefix>00001@tensai.test
 *   SEED_BCRYPT_ROUNDS=10   bcrypt cost (10 = app default)
 *   SEED_MANIFEST=scripts/out/test-credentials.json  output path (gitignored)
 *
 * Usage:
 *   php bin/seed-test-data.php
 *   SEED_USERS=20 php bin/seed-test-data.php    # quick validation
 */

require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Db, Migrations};

$N       = env_int('SEED_USERS', 5000);
$TX_PER  = env_int('SEED_TX_PER_USER', 8);
$PREFIX  = env_str('SEED_PREFIX', 'tuser');
$ROUNDS  = env_int('SEED_BCRYPT_ROUNDS', 10);
$PAD     = strlen((string) $N);
$MANIFEST = __DIR__ . '/../' . env_str('SEED_MANIFEST', 'scripts/out/test-credentials.json');

$FIRST = explode(' ', 'James Mary John Patricia Robert Jennifer Michael Linda William Elizabeth David Barbara Richard Susan Joseph Jessica Thomas Karen Charles Sarah Chris Nancy Daniel Lisa Matthew Betty Anthony Sandra Mark Ashley Ava Noah Mia Liam Zoe Ethan Nora Ian Priya Raj Aisha Omar Wei Ling Diego Sofia Yuki Hana');
$LAST  = explode(' ', 'Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez White Harris Clark Lewis Young King Wright Hill Patel Khan Chen Nguyen Kumar Mehta Ali Costa Rossi Sato');
$BANKS = ['Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'US Bank', 'PNC Bank', 'Capital One', 'TD Bank', 'Truist', 'Tensai SecBank'];
$BILLERS = [['Verizon', 'PHONE'], ['Comcast', 'INTERNET'], ['Netflix', 'STREAMING'], ['ConEd', 'ELECTRICITY'], ['Spotify', 'STREAMING'], ['AmEx', 'CREDIT_CARD'], ['Geico', 'INSURANCE']];
$INV_TYPES = [['MUTUAL_FUND', 'Vanguard 500'], ['FIXED_DEPOSIT', '12-mo CD'], ['STOCKS', 'Blue-chip stocks'], ['LIFE_INSURANCE', 'Term life'], ['RECURRING_DEPOSIT', 'Monthly RD']];
$CARD_COLORS = ['sky', 'violet', 'emerald', 'peach'];
$OCCUPATIONS = ['Engineer', 'Teacher', 'Doctor', 'Analyst', 'Designer', 'Nurse', 'Manager'];
$NICKS = ['Mom', 'Landlord', 'Friend', 'Vendor', 'Savings'];

$FAILURES = [
    ['CORE_TIMEOUT', 'legacy core banking timeout', 3], ['API_FAILURE', 'api/middleware failure', 3],
    ['FRAUD_TIMEOUT', 'fraud-engine evaluation timeout', 2], ['DB_DEADLOCK', 'database deadlock detected', 2],
    ['NETWORK_LATENCY', 'upstream network latency exceeded', 2], ['OTP_DELAY', 'otp/mfa delivery delay', 2],
    ['DISTRIBUTED_INCONSISTENCY', 'distributed-service inconsistency, rolled back', 2],
    ['PROCESSOR_OUTAGE', 'third-party processor outage', 2], ['INFRA_FAILURE', 'load-balancer / infrastructure failure', 1],
    ['INSUFFICIENT_FUNDS', 'insufficient funds', 3], ['INVALID_ACCOUNT', 'invalid destination account details', 2],
    ['LIMIT_EXCEEDED', 'transfer-limit violation', 2], ['EXPIRED_CARD', 'expired card attempt', 1],
];
$FAIL_BAG = [];
foreach ($FAILURES as [$c, $r, $w]) for ($j = 0; $j < $w; $j++) $FAIL_BAG[] = [$c, $r];

function env_int(string $k, int $d): int { $v = $_ENV[$k] ?? getenv($k); return is_numeric($v) ? (int) $v : $d; }
function env_str(string $k, string $d): string { $v = $_ENV[$k] ?? getenv($k); return ($v !== false && $v !== null && $v !== '') ? (string) $v : $d; }
function rnd(float $a, float $b): float { return $a + (mt_rand() / mt_getrandmax()) * ($b - $a); }
function rint(int $a, int $b): int { return mt_rand($a, $b); }
function pick(array $a) { return $a[mt_rand(0, count($a) - 1)]; }
function digits(int $n): string { $s = ''; for ($i = 0; $i < $n; $i++) $s .= mt_rand(0, 9); return $s; }
function money($v): string { return number_format((float) $v, 2, '.', ''); }
function daysAgoIso(float $d): string { return date('c', (int) (time() - $d * 86400)); }
function cap(string $s): string { return ucfirst(strtolower($s)); }
function shuffleArr(array $a): array { shuffle($a); return $a; }

if (empty($_ENV['DATABASE_URL'] ?? getenv('DATABASE_URL'))) { fwrite(STDERR, "[seed] FATAL: DATABASE_URL is not set\n"); exit(1); }

$started = microtime(true);
fwrite(STDERR, "[seed] users=$N tx/user=$TX_PER rounds=$ROUNDS (no OTEL)\n");

$pdo = Db::pdo();
Migrations::run(__DIR__ . '/../migrations'); // idempotent; also applies catalog seed (0005)

$cardProducts = Db::all('SELECT id, card_type, network FROM card_products');
$loanProducts = Db::all('SELECT * FROM loan_products');
$rewardTasks  = Db::all('SELECT id, points FROM reward_tasks');

$existing = Db::all('SELECT email FROM users WHERE email LIKE :p', [':p' => $PREFIX . '%@tensai.test']);
$seen = array_flip(array_column($existing, 'email'));

$manifest = [];
$created = 0; $skipped = 0; $txOk = 0; $txFail = 0;

for ($i = 1; $i <= $N; $i++) {
    $email = $PREFIX . str_pad((string) $i, $PAD, '0', STR_PAD_LEFT) . '@tensai.test';
    if (isset($seen[$email])) { $skipped++; continue; }

    $r = seedOneUser($pdo, $i, $email, $ROUNDS, $TX_PER, $cardProducts, $loanProducts, $rewardTasks,
        $FIRST, $LAST, $BANKS, $BILLERS, $INV_TYPES, $CARD_COLORS, $OCCUPATIONS, $NICKS, $FAIL_BAG);
    $manifest[] = $r['credentials'];
    $created++; $txOk += $r['txOk']; $txFail += $r['txFail'];
    if ($created % 250 === 0) fwrite(STDERR, "[seed] created=$created skipped=$skipped tx(ok=$txOk fail=$txFail) t=" . sec($started) . "s\n");
}

writeManifest($MANIFEST, $manifest);
fwrite(STDERR, "[seed] done: created=$created skipped=$skipped tx(ok=$txOk fail=$txFail) in " . sec($started) . "s\n");
if ($created > 0) selfCheck();

function seedOneUser(PDO $pdo, int $i, string $email, int $rounds, int $txPer, array $cardProducts, array $loanProducts, array $rewardTasks,
    array $FIRST, array $LAST, array $BANKS, array $BILLERS, array $INV_TYPES, array $CARD_COLORS, array $OCCUPATIONS, array $NICKS, array $FAIL_BAG): array
{
    $name = pick($FIRST) . ' ' . pick($LAST);
    $mobile = (string) (8900000000 + $i);
    $password = "Seed-$i-" . digits(4);
    $mpin = digits(6);
    $passwordHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => $rounds]);
    $mpinHash = password_hash($mpin, PASSWORD_BCRYPT, ['cost' => $rounds]);

    return Db::tx(function (PDO $pdo) use ($i, $email, $name, $mobile, $password, $mpin, $passwordHash, $mpinHash,
        $txPer, $cardProducts, $loanProducts, $rewardTasks, $FIRST, $LAST, $BANKS, $BILLERS, $INV_TYPES, $CARD_COLORS, $OCCUPATIONS, $NICKS, $FAIL_BAG) {

        $st = $pdo->prepare('INSERT INTO users (email, name, password_hash, mobile_number, pan, occupation, pin_code)
            VALUES (?,?,?,?,?,?,?) RETURNING id');
        $st->execute([$email, $name, $passwordHash, $mobile, strtoupper('AAAAA' . digits(4) . 'A'), pick($OCCUPATIONS), digits(6)]);
        $userId = $st->fetch()['id'];
        $pdo->prepare('INSERT INTO mpin_credentials (user_id, mpin_hash) VALUES (?,?)')->execute([$userId, $mpinHash]);

        $primaryNo = (string) (8900000000 + $i * 2);
        $primary = insertAccount($pdo, $userId, $primaryNo, 'SAVINGS', 'Primary Savings', true);
        openingDeposit($pdo, $primary, money(rnd(2000, 60000)));

        $secondary = null;
        if (rnd(0, 1) < 0.55) {
            $kind = pick(['SALARY', 'BUSINESS', 'INVESTMENT']);
            $secondary = insertAccount($pdo, $userId, (string) (8900000000 + $i * 2 + 1), $kind, cap($kind) . ' Account', false);
            openingDeposit($pdo, $secondary, money(rnd(500, 20000)));
        }

        if ($cardProducts) for ($c = rint(0, 2); $c > 0; $c--) {
            $p = pick($cardProducts);
            $pdo->prepare('INSERT INTO cards (user_id, holder_name, last_four, full_number, cvv, expiry_month, expiry_year, type, brand, network, color_hint, product_id, account_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')->execute([
                $userId, $name, digits(4), '4' . digits(15), digits(3), rint(1, 12), ((int) date('Y') + rint(2, 5)) % 100,
                $p['cardType'], $p['network'] ?: 'MASTERCARD', $p['network'] ?: 'MASTERCARD', pick($CARD_COLORS), $p['id'], $primary]);
        }

        for ($b = rint(2, 4); $b > 0; $b--) {
            [$biller, $category] = pick($BILLERS);
            $pdo->prepare('INSERT INTO bills (user_id, biller_name, category, amount, due_date, status) VALUES (?,?,?,?,?,?)')
                ->execute([$userId, $biller, $category, money(rnd(15, 900)), daysAgoIso(-rint(1, 20)), rnd(0, 1) < 0.3 ? 'PAID' : 'DUE']);
        }

        for ($v = rint(1, 4); $v > 0; $v--) {
            [$type, $nm] = pick($INV_TYPES);
            $invested = rnd(1000, 50000);
            $pdo->prepare('INSERT INTO investments (user_id, type, name, invested_amount, current_value, monthly_contribution, return_pct, frequency_label)
                VALUES (?,?,?,?,?,?,?,?)')->execute([
                $userId, $type, $nm, money($invested), money($invested * rnd(0.9, 1.25)), money(rnd(50, 1000)), money(rnd(-5, 15)), 'monthly']);
        }

        for ($p = rint(1, 3); $p > 0; $p--) {
            try {
                $pdo->prepare('INSERT INTO payees (user_id, bank_name, account_number, account_holder_name, nickname) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
                    ->execute([$userId, pick($BANKS), digits(rint(10, 14)), pick($FIRST) . ' ' . pick($LAST), pick($NICKS)]);
            } catch (\Throwable $e) { /* unique clash on random acct no; skip */ }
        }

        if ($secondary) $pdo->prepare('INSERT INTO beneficiaries (user_id, to_account_id, nickname) VALUES (?,?,?) ON CONFLICT DO NOTHING')
            ->execute([$userId, $secondary, 'My other account']);

        if ($loanProducts && rnd(0, 1) < 0.4) {
            $lp = pick($loanProducts);
            $principal = rnd((float) $lp['minAmount'], min((float) $lp['maxAmount'], 200000));
            $tenure = rint((int) $lp['minTenure'], (int) $lp['maxTenure']);
            $rate = (float) $lp['interestRate'];
            [$emi, $ti, $tr] = computeLoan($principal, $rate, $tenure);
            $pdo->prepare('INSERT INTO loan_applications (user_id, product_id, principal, tenure_months, interest_rate, emi, total_interest, total_repayment, status)
                VALUES (?,?,?,?,?,?,?,?,?)')->execute([
                $userId, $lp['id'], money($principal), $tenure, money($rate), money($emi), money($ti), money($tr),
                pick(['PENDING', 'APPROVED', 'DISBURSED'])]);
        }

        if ($rewardTasks) {
            $awarded = array_slice(shuffleArr($rewardTasks), 0, rint(3, 15));
            $rst = $pdo->prepare('INSERT INTO user_reward_tasks (user_id, task_id, points_awarded) VALUES (?,?,?) ON CONFLICT DO NOTHING');
            foreach ($awarded as $task) $rst->execute([$userId, $task['id'], $task['points']]);
        }

        $pdo->prepare('INSERT INTO notifications (user_id, title, body, category, severity) VALUES (?,?,?,?,?)')
            ->execute([$userId, 'Welcome to Tensai SecBank', 'Your synthetic test account is ready.', 'WELCOME', 'INFO']);

        $txOk = 0; $txFail = 0;
        for ($k = 0; $k < $txPer; $k++) {
            $when = daysAgoIso(rnd(0, 30));
            $ok = rnd(0, 1) < 0.62
                ? successTx($pdo, $i, $k, $primary, $secondary, $when)
                : failureTx($pdo, $i, $k, $primary, $secondary, $when, $FAIL_BAG);
            $ok ? $txOk++ : $txFail++;
        }

        return ['txOk' => $txOk, 'txFail' => $txFail,
            'credentials' => ['userId' => $userId, 'identifier' => $email, 'email' => $email, 'mobileNumber' => $mobile, 'password' => $password, 'mpin' => $mpin]];
    });
}

function insertAccount(PDO $pdo, string $userId, string $acctNo, string $kind, string $name, bool $primary): string
{
    $st = $pdo->prepare('INSERT INTO accounts (user_id, account_number, kind, display_name, is_primary, currency) VALUES (?,?,?,?,?,?) RETURNING id');
    $st->execute([$userId, $acctNo, $kind, $name, $primary ? 'true' : 'false', 'USD']);
    return $st->fetch()['id'];
}

function openingDeposit(PDO $pdo, string $accountId, string $amount): void
{
    $st = $pdo->prepare("INSERT INTO transactions (from_account_id, to_account_id, amount, status, idempotency_key, description, category)
        VALUES (?,?,?,'COMPLETED',?,?, 'WELCOME_BONUS') RETURNING id");
    $st->execute([$accountId, $accountId, $amount, "seed-open-$accountId", '[SYNTHETIC] opening balance']);
    $txId = $st->fetch()['id'];
    $pdo->prepare("INSERT INTO ledger_entries (account_id, transaction_id, type, amount) VALUES (?,?,'CREDIT',?)")->execute([$accountId, $txId, $amount]);
}

function successTx(PDO $pdo, int $i, int $k, string $primary, ?string $secondary, string $when): bool
{
    $amount = money(rnd(10, 1500));
    $key = "seed-tx-$i-$k-" . digits(6);
    $doTransfer = $secondary && rnd(0, 1) < 0.6;
    if ($doTransfer) {
        $b = $pdo->prepare("SELECT COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS bal FROM ledger_entries WHERE account_id = ?");
        $b->execute([$primary]);
        if ((float) $b->fetch()['bal'] < (float) $amount) $doTransfer = false;
    }
    $toId = $doTransfer ? $secondary : $primary;
    $op = $doTransfer ? 'transfer.internal' : 'deposit';
    $st = $pdo->prepare('INSERT INTO transactions (from_account_id, to_account_id, amount, status, idempotency_key, description, category, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) RETURNING id');
    $st->execute([$primary, $toId, $amount, 'COMPLETED', $key, "[SYNTHETIC] $op", $doTransfer ? 'TRANSFER' : 'DEPOSIT', $when, $when]);
    $txId = $st->fetch()['id'];
    $le = $pdo->prepare('INSERT INTO ledger_entries (account_id, transaction_id, type, amount) VALUES (?,?,?,?)');
    if ($doTransfer) { $le->execute([$primary, $txId, 'DEBIT', $amount]); $le->execute([$toId, $txId, 'CREDIT', $amount]); }
    else $le->execute([$toId, $txId, 'CREDIT', $amount]);
    return true;
}

function failureTx(PDO $pdo, int $i, int $k, string $primary, ?string $secondary, string $when, array $FAIL_BAG): bool
{
    [$category, $reason] = pick($FAIL_BAG);
    $amount = money(rnd(10, 5000));
    $key = "seed-fail-$i-$k-" . digits(6);
    $toId = $secondary ?: $primary;
    $pdo->prepare('INSERT INTO transactions (from_account_id, to_account_id, amount, status, idempotency_key, description, category, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)')->execute([$primary, $toId, $amount, 'FAILED', $key, "[SYNTHETIC] FAILED: $reason", $category, $when, $when]);
    return false; // FAILED row, NO ledger entries -> balance untouched
}

function computeLoan(float $principal, float $annualRatePct, int $months): array
{
    $r = $annualRatePct / 100 / 12;
    $emi = $r == 0.0 ? $principal / $months : ($principal * $r * (1 + $r) ** $months) / ((1 + $r) ** $months - 1);
    $total = $emi * $months;
    return [$emi, $total - $principal, $total];
}

function selfCheck(): void
{
    $n1 = (int) Db::one("SELECT COUNT(*)::int AS n FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id WHERE t.status='FAILED'")['n'];
    $n2 = (int) Db::one("SELECT COUNT(*)::int AS n FROM (SELECT transaction_id, SUM(CASE WHEN type='DEBIT' THEN amount ELSE 0 END) d, SUM(CASE WHEN type='CREDIT' THEN amount ELSE 0 END) c, COUNT(*) entries FROM ledger_entries GROUP BY transaction_id) x WHERE entries=2 AND d<>c")['n'];
    $n3 = (int) Db::one("SELECT COUNT(*)::int AS n FROM (SELECT account_id, SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END) bal FROM ledger_entries GROUP BY account_id) y WHERE bal < 0")['n'];
    fwrite(STDERR, "[seed] self-check: failed-with-ledger=$n1 unbalanced-transfers=$n2 negative-balances=$n3\n");
    if ($n1 || $n2 || $n3) { fwrite(STDERR, "[seed] FATAL: ledger integrity violated ($n1/$n2/$n3)\n"); exit(1); }
    fwrite(STDERR, "[seed] self-check OK: ledger integrity preserved\n");
}

function writeManifest(string $path, array $rows): void
{
    if (!$rows) { fwrite(STDERR, "[seed] no new users -> manifest unchanged\n"); return; }
    @mkdir(dirname($path), 0700, true);
    $prev = [];
    if (is_file($path)) { $prev = json_decode(file_get_contents($path), true) ?: []; }
    $byId = [];
    foreach ($prev as $r) $byId[$r['userId']] = $r;
    foreach ($rows as $r) $byId[$r['userId']] = $r;
    file_put_contents($path, json_encode(array_values($byId), JSON_PRETTY_PRINT));
    @chmod($path, 0600);
    fwrite(STDERR, "[seed] credential manifest -> $path (" . count($byId) . " users) [DO NOT COMMIT]\n");
}

function sec(float $t): string { return number_format(microtime(true) - $t, 1); }
