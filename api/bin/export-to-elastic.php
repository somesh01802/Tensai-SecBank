<?php
/**
 * Copy the business data in Postgres — users, accounts, transactions, login
 * events — into Elasticsearch so Kibana can chart it, including all the
 * historical rows (the seeded users and their transactions) that existed
 * before APM was switched on. Read-only on Postgres; never exports password
 * hashes, MPINs, PAN or mobile numbers.
 *
 * Idempotent: every row is indexed with its DB id as the document _id, so a
 * re-run updates documents instead of duplicating them.
 *
 * Config (api/.env or environment):
 *   ES_URL=https://<host>:<port>     Elasticsearch endpoint (NOT the APM URL)
 *   ES_API_KEY=<encoded key>         or ES_USER + ES_PASS
 *   ES_INSECURE=1                    skip TLS verification (self-signed certs)
 *
 *   php bin/export-to-elastic.php                     full export
 *   php bin/export-to-elastic.php --incremental       only what changed since the last successful
 *                                                     --incremental run (first run = full). Use this in cron:
 *                                                     the checkpoint (var/export-state.json) means a missed
 *                                                     or failed run never loses data.
 *   php bin/export-to-elastic.php --since-minutes=15  changes in the last N minutes (manual catch-up)
 *   php bin/export-to-elastic.php --dry-run           count rows + show a sample doc, send nothing
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\Db;

function envv(string $k): ?string
{
    $v = $_ENV[$k] ?? getenv($k);
    return ($v === false || $v === '') ? null : (string) $v;
}

/** One Elasticsearch request. Returns [status, decoded JSON]. */
function es(string $method, string $path, string $body = '', string $ctype = 'application/json'): array
{
    $h = ['Content-Type: ' . $ctype];
    if ($k = envv('ES_API_KEY')) $h[] = 'Authorization: ApiKey ' . $k;
    $ch = curl_init(rtrim((string) envv('ES_URL'), '/') . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 120]);
    if (!envv('ES_API_KEY') && envv('ES_USER')) curl_setopt($ch, CURLOPT_USERPWD, envv('ES_USER') . ':' . envv('ES_PASS'));
    if (envv('ES_INSECURE')) { curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0); }
    if ($body !== '') curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException("Elasticsearch unreachable: $err");
    return [$code, json_decode($raw, true) ?: []];
}

function ts(?string $v): ?string
{
    return $v ? (new DateTimeImmutable($v))->format('Y-m-d\TH:i:s.vP') : null;
}

const MAPPING = ['mappings' => [
    // Strings default to keyword (aggregatable in dashboards).
    'dynamic_templates' => [['strings' => ['match_mapping_type' => 'string',
        'mapping' => ['type' => 'keyword', 'ignore_above' => 1024]]]],
    'properties' => [
        '@timestamp' => ['type' => 'date'], 'last_login_at' => ['type' => 'date'],
        'amount' => ['type' => 'double'], 'balance' => ['type' => 'double'], 'total_balance' => ['type' => 'double'],
        'description' => ['type' => 'text', 'fields' => ['keyword' => ['type' => 'keyword', 'ignore_above' => 256]]],
    ],
]];

function ensureIndex(string $index): void
{
    [$code, $j] = es('PUT', '/' . $index, json_encode(MAPPING));
    $type = $j['error']['type'] ?? '';
    if ($code >= 300 && $type !== 'resource_already_exists_exception')
        throw new RuntimeException("create index $index HTTP $code: " . json_encode($j['error'] ?? $j));
}

function export(string $index, string $sql, callable $map, bool $dry): int
{
    if (!$dry) ensureIndex($index);
    $st = Db::pdo()->query($sql);
    $buf = ''; $n = 0; $failed = 0; $sample = null;
    $flush = function () use (&$buf, &$failed, $index) {
        if ($buf === '') return;
        [$code, $j] = es('POST', '/_bulk', $buf, 'application/x-ndjson');
        $buf = '';
        if ($code >= 300) throw new RuntimeException("bulk $index HTTP $code: " . json_encode($j['error'] ?? $j));
        if (empty($j['errors'])) return;
        foreach ($j['items'] as $it) {
            $r = reset($it);
            if (isset($r['error']) && $failed++ === 0) fwrite(STDERR, "  first error: " . json_encode($r['error']) . "\n");
        }
    };
    while ($row = $st->fetch()) {
        $doc = $map($row);
        $sample ??= $doc;
        $n++;
        if ($dry) continue;
        $buf .= json_encode(['index' => ['_index' => $index, '_id' => (string) $row['id']]]) . "\n"
              . json_encode($doc, JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
        if ($n % 1000 === 0) $flush();
    }
    if (!$dry) $flush();
    printf("[export] %-20s %7d docs%s\n", $index, $n, $failed ? " ($failed FAILED)" : '');
    if ($dry && $sample) echo '  sample: ' . json_encode($sample) . "\n";
    return $failed;
}

$o = getopt('', ['since-minutes::', 'incremental', 'dry-run']);
$dry = isset($o['dry-run']);
$incremental = isset($o['incremental']);
if (!$dry && !envv('ES_URL')) { fwrite(STDERR, "ES_URL is not set — see the header of this script.\n"); exit(1); }

// Cut-off as a SQL expression (null = full export). Times come from the DB
// clock so PHP/DB clock skew can't open a gap.
$stateFile = __DIR__ . '/../var/export-state.json';
$startedAt = (string) Db::pdo()->query('SELECT now()')->fetchColumn();
$cutoff = null;
if (isset($o['since-minutes'])) {
    $cutoff = "now() - interval '" . max(1, (int) $o['since-minutes']) . " minutes'";
} elseif ($incremental && is_file($stateFile)) {
    $last = json_decode((string) file_get_contents($stateFile), true)['last_run'] ?? null;
    // Re-format through DateTimeImmutable so only a valid timestamp reaches the SQL.
    // 2-minute overlap catches rows committed just after the previous run read; _id makes it harmless.
    if ($last) $cutoff = "'" . (new DateTimeImmutable($last))->format('Y-m-d H:i:s.uP') . "'::timestamptz - interval '2 minutes'";
}
echo '[export] mode: ' . ($cutoff ? "changes since $cutoff" : 'full') . "\n";
$since = fn(string $col) => $cutoff ? "$col >= ($cutoff)" : 'TRUE';

$balance = "COALESCE(SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0)";
$failed = 0;

// Users / accounts: re-sent when anything that feeds their computed fields
// (balance, login count, status) changed — not just when the row was created.
$failed += export('tensai-users', "
    SELECT u.id, u.name, u.email, u.occupation, u.is_system_user, u.created_at,
           (SELECT count(*) FROM accounts a WHERE a.user_id = u.id) AS accounts_count,
           (SELECT $balance FROM ledger_entries le JOIN accounts a ON a.id = le.account_id WHERE a.user_id = u.id) AS total_balance,
           (SELECT count(*) FROM login_events l WHERE l.user_id = u.id AND l.event = 'login' AND l.outcome = 'success') AS login_count,
           (SELECT max(l.created_at) FROM login_events l WHERE l.user_id = u.id AND l.event = 'login' AND l.outcome = 'success') AS last_login_at
    FROM users u
    WHERE " . ($cutoff ? $since('u.created_at') . ' OR ' . $since('u.updated_at') . "
       OR EXISTS (SELECT 1 FROM login_events l WHERE l.user_id = u.id AND " . $since('l.created_at') . ")
       OR EXISTS (SELECT 1 FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
                  WHERE a.user_id = u.id AND " . $since('le.created_at') . ")" : 'TRUE'),
    fn($r) => ['@timestamp' => ts($r['created_at']), 'user_id' => $r['id'], 'name' => $r['name'], 'email' => $r['email'],
        'occupation' => $r['occupation'], 'is_system_user' => (bool) $r['is_system_user'],
        'accounts_count' => (int) $r['accounts_count'], 'total_balance' => (float) $r['total_balance'],
        'login_count' => (int) $r['login_count'], 'last_login_at' => ts($r['last_login_at'])],
    $dry);

$failed += export('tensai-accounts', "
    SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email, a.account_number, a.kind, a.status,
           a.is_primary, a.currency, a.display_name, a.created_at, $balance AS balance
    FROM accounts a JOIN users u ON u.id = a.user_id
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    WHERE " . ($cutoff ? $since('a.created_at') . ' OR ' . $since('a.updated_at') . "
       OR EXISTS (SELECT 1 FROM ledger_entries x WHERE x.account_id = a.id AND " . $since('x.created_at') . ")" : 'TRUE') . "
    GROUP BY a.id, u.name, u.email",
    fn($r) => ['@timestamp' => ts($r['created_at']), 'account_id' => $r['id'], 'user_id' => $r['user_id'],
        'user_name' => $r['user_name'], 'user_email' => $r['user_email'], 'account_number' => $r['account_number'],
        'kind' => $r['kind'], 'status' => $r['status'], 'is_primary' => (bool) $r['is_primary'],
        'currency' => $r['currency'], 'display_name' => $r['display_name'], 'balance' => (float) $r['balance']],
    $dry);

$failed += export('tensai-transactions', "
    SELECT t.id, t.amount, t.status, t.category, t.description, t.created_at, t.from_account_id, t.to_account_id,
           fa.currency, fu.name AS from_user, fu.email AS from_email, tu.name AS to_user, tu.email AS to_email
    FROM transactions t
    JOIN accounts fa ON fa.id = t.from_account_id JOIN users fu ON fu.id = fa.user_id
    JOIN accounts ta ON ta.id = t.to_account_id   JOIN users tu ON tu.id = ta.user_id
    WHERE " . $since('t.created_at') . ' OR ' . $since('t.updated_at'),
    fn($r) => ['@timestamp' => ts($r['created_at']), 'transaction_id' => $r['id'], 'amount' => (float) $r['amount'],
        'status' => $r['status'], 'category' => $r['category'], 'description' => $r['description'],
        'currency' => $r['currency'], 'from_account_id' => $r['from_account_id'], 'to_account_id' => $r['to_account_id'],
        'from_user' => $r['from_user'], 'from_email' => $r['from_email'], 'to_user' => $r['to_user'], 'to_email' => $r['to_email'],
        'self_transfer' => $r['from_account_id'] === $r['to_account_id']],
    $dry);

$failed += export('tensai-login-events', "
    SELECT id, user_id, username, email, event, outcome, method, ip, created_at FROM login_events
    WHERE " . $since('created_at'),
    fn($r) => ['@timestamp' => ts($r['created_at']), 'user_id' => $r['user_id'], 'username' => $r['username'],
        'email' => $r['email'], 'event' => $r['event'], 'outcome' => $r['outcome'], 'method' => $r['method'], 'ip' => $r['ip']],
    $dry);

if ($dry) { echo "[export] dry run — nothing sent\n"; exit(0); }
if ($failed > 0) { fwrite(STDERR, "[export] $failed docs failed — checkpoint NOT advanced, next run retries them\n"); exit(1); }
if ($incremental) {
    @mkdir(dirname($stateFile), 0750, true);
    file_put_contents($stateFile, json_encode(['last_run' => $startedAt]));
}
echo "[export] done\n";
