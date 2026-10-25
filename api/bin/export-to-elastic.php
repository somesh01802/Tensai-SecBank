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

use Tensai\{Db, Apm};

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

/**
 * Fields added by the 0007 upgrade whose type dynamic mapping would get wrong
 * (geo_point must be explicit; dates/numbers pinned). Applied to EXISTING
 * indices with a put-mapping — additive only: new field names, no existing
 * field is changed, so current dashboards/searches keep working.
 */
const ADDED_FIELDS = [
    'geo_location' => ['type' => 'geo_point'],
    'location_accuracy_m' => ['type' => 'double'],
    'is_synthetic' => ['type' => 'boolean'],
    'duration_ms' => ['type' => 'long'],
    'http_status' => ['type' => 'long'],
    'attempt_at' => ['type' => 'date'],
    'feedback_at' => ['type' => 'date'],
];

const MAPPING = ['mappings' => [
    // Strings default to keyword (aggregatable in dashboards).
    'dynamic_templates' => [['strings' => ['match_mapping_type' => 'string',
        'mapping' => ['type' => 'keyword', 'ignore_above' => 1024]]]],
    'properties' => [
        '@timestamp' => ['type' => 'date'], 'last_login_at' => ['type' => 'date'],
        'amount' => ['type' => 'double'], 'balance' => ['type' => 'double'], 'total_balance' => ['type' => 'double'],
        'description' => ['type' => 'text', 'fields' => ['keyword' => ['type' => 'keyword', 'ignore_above' => 256]]],
    ] + ADDED_FIELDS,
]];

function ensureIndex(string $index): void
{
    [$code, $j] = es('PUT', '/' . $index, json_encode(MAPPING));
    $type = $j['error']['type'] ?? '';
    if ($code < 300) return; // created fresh with the full mapping
    if ($type !== 'resource_already_exists_exception')
        throw new RuntimeException("create index $index HTTP $code: " . json_encode($j['error'] ?? $j));
    // Existing index (the one the dashboards use): add only the new fields.
    [$code, $j] = es('PUT', "/$index/_mapping", json_encode(['properties' => ADDED_FIELDS]));
    if ($code >= 300)
        throw new RuntimeException("add fields to $index HTTP $code (an existing field has a different type?): "
            . json_encode($j['error'] ?? $j));
}

/** Coarsened coordinates for Kibana (2 dp ≈ 1.1 km): enough for a distribution map, not a home address. */
function geo(?string $lat, ?string $lon): ?array
{
    return ($lat !== null && $lon !== null) ? ['lat' => round((float) $lat, 2), 'lon' => round((float) $lon, 2)] : null;
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
    SELECT u.id, u.name, u.email, u.occupation, u.is_system_user, u.created_at, u.role, u.is_synthetic,
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
        'login_count' => (int) $r['login_count'], 'last_login_at' => ts($r['last_login_at']),
        // 0007 additive fields
        'role' => $r['role'], 'is_synthetic' => (bool) $r['is_synthetic'], 'user_ref' => Apm::userRef($r['id'])],
    $dry);

$failed += export('tensai-accounts', "
    SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email, a.account_number, a.kind, a.status,
           a.is_primary, a.currency, a.display_name, a.created_at, $balance AS balance, u.is_synthetic
    FROM accounts a JOIN users u ON u.id = a.user_id
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    WHERE " . ($cutoff ? $since('a.created_at') . ' OR ' . $since('a.updated_at') . "
       OR EXISTS (SELECT 1 FROM ledger_entries x WHERE x.account_id = a.id AND " . $since('x.created_at') . ")" : 'TRUE') . "
    GROUP BY a.id, u.name, u.email, u.is_synthetic",
    fn($r) => ['@timestamp' => ts($r['created_at']), 'account_id' => $r['id'], 'user_id' => $r['user_id'],
        'user_name' => $r['user_name'], 'user_email' => $r['user_email'], 'account_number' => $r['account_number'],
        'kind' => $r['kind'], 'status' => $r['status'], 'is_primary' => (bool) $r['is_primary'],
        'currency' => $r['currency'], 'display_name' => $r['display_name'], 'balance' => (float) $r['balance'],
        'is_synthetic' => (bool) $r['is_synthetic']],
    $dry);

// One doc per completed ledger transaction (_id = transaction id, as before) enriched
// with its attempt + feedback, PLUS one doc per FAILED attempt (_id = attempt id,
// status FAILED, record_type failed_attempt) — failures never created a ledger row.
// Panels that mean "ledger transactions" filter: not record_type : "failed_attempt".
$failed += export('tensai-transactions', "
    SELECT * FROM (
        SELECT t.id::text AS id, 'transaction' AS record_type, t.id AS transaction_id, t.amount, t.status::text AS status,
               t.category, t.description, t.created_at, t.updated_at, t.from_account_id, t.to_account_id, fa.currency,
               fu.id AS user_id, fu.name AS from_user, fu.email AS from_email, tu.name AS to_user, tu.email AS to_email,
               fu.is_synthetic, a.id AS attempt_id, a.kind, a.outcome, a.error_category, a.error_message, a.duration_ms,
               a.http_status, a.trace_id, a.session_id, a.target, a.fault_injected, a.created_at AS attempt_at,
               f.status AS feedback_status, f.rating AS feedback_rating, f.created_at AS feedback_at
        FROM transactions t
        JOIN accounts fa ON fa.id = t.from_account_id JOIN users fu ON fu.id = fa.user_id
        JOIN accounts ta ON ta.id = t.to_account_id   JOIN users tu ON tu.id = ta.user_id
        LEFT JOIN (SELECT DISTINCT ON (transaction_id) * FROM transaction_attempts
                   -- the ORIGINAL attempt that created the transaction (idempotent retries link to it too)
                   WHERE transaction_id IS NOT NULL ORDER BY transaction_id, created_at ASC) a ON a.transaction_id = t.id
        LEFT JOIN transaction_feedback f ON f.attempt_id = a.id
        UNION ALL
        SELECT a.id::text, 'failed_attempt', NULL::uuid, a.amount, 'FAILED', a.category, a.error_message, a.created_at, a.created_at,
               a.source_account_id, NULL::uuid, a.currency, u.id, u.name, u.email, NULL, NULL, u.is_synthetic,
               a.id, a.kind, a.outcome, a.error_category, a.error_message, a.duration_ms, a.http_status, a.trace_id, a.session_id,
               a.target, a.fault_injected, a.created_at, f.status, f.rating, f.created_at
        FROM transaction_attempts a JOIN users u ON u.id = a.user_id
        LEFT JOIN transaction_feedback f ON f.attempt_id = a.id
        WHERE a.transaction_id IS NULL AND a.outcome = 'FAILURE'
    ) x
    WHERE " . $since('x.created_at') . ' OR ' . $since('x.updated_at') . ' OR ' . $since('x.attempt_at') . ' OR ' . $since('x.feedback_at'),
    fn($r) => ['@timestamp' => ts($r['created_at']), 'transaction_id' => $r['transaction_id'],
        'amount' => $r['amount'] !== null ? (float) $r['amount'] : null,
        'status' => $r['status'], 'category' => $r['category'], 'description' => $r['description'],
        'currency' => $r['currency'], 'from_account_id' => $r['from_account_id'], 'to_account_id' => $r['to_account_id'],
        'from_user' => $r['from_user'], 'from_email' => $r['from_email'], 'to_user' => $r['to_user'], 'to_email' => $r['to_email'],
        'self_transfer' => $r['to_account_id'] !== null && $r['from_account_id'] === $r['to_account_id'],
        // 0007 additive fields
        'record_type' => $r['record_type'], 'attempt_id' => $r['attempt_id'], 'kind' => $r['kind'],
        'outcome' => $r['outcome'] ? strtolower($r['outcome']) : ($r['status'] === 'COMPLETED' ? 'success' : strtolower($r['status'])),
        'error_category' => $r['error_category'], 'failure_reason' => $r['outcome'] === 'FAILURE' ? $r['error_message'] : null,
        'duration_ms' => $r['duration_ms'] !== null ? (int) $r['duration_ms'] : null,
        'http_status' => $r['http_status'] !== null ? (int) $r['http_status'] : null,
        'trace_id' => $r['trace_id'], 'session_id' => $r['session_id'], 'target' => $r['target'],
        'fault_injected' => $r['fault_injected'] === null ? null : (bool) $r['fault_injected'],
        'attempt_at' => ts($r['attempt_at']), 'is_synthetic' => (bool) $r['is_synthetic'], 'user_ref' => Apm::userRef($r['user_id']),
        'feedback_status' => $r['feedback_status'] ? strtolower($r['feedback_status']) : null,
        'feedback_rating' => $r['feedback_rating'], 'feedback_at' => ts($r['feedback_at'])],
    $dry);

// Login events enriched with the consent-based location outcome (no row → "unknown").
$failed += export('tensai-login-events', "
    SELECT l.id, l.user_id, l.username, l.email, l.event, l.outcome, l.method, l.ip, l.created_at, l.session_id,
           u.is_synthetic, ll.status AS location_status, ll.latitude, ll.longitude, ll.accuracy_m
    FROM login_events l
    LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN login_locations ll ON ll.login_event_id = l.id
    WHERE " . $since('l.created_at') . ' OR ' . $since('ll.created_at'),
    fn($r) => ['@timestamp' => ts($r['created_at']), 'user_id' => $r['user_id'], 'username' => $r['username'],
        'email' => $r['email'], 'event' => $r['event'], 'outcome' => $r['outcome'], 'method' => $r['method'], 'ip' => $r['ip'],
        // 0007 additive fields
        'session_id' => $r['session_id'], 'user_ref' => Apm::userRef($r['user_id']), 'is_synthetic' => (bool) $r['is_synthetic'],
        'location_status' => $r['location_status'] ?? 'unknown',
        'geo_location' => geo($r['latitude'], $r['longitude']),
        'location_accuracy_m' => $r['accuracy_m'] !== null ? (float) $r['accuracy_m'] : null],
    $dry);

if ($dry) { echo "[export] dry run — nothing sent\n"; exit(0); }
if ($failed > 0) { fwrite(STDERR, "[export] $failed docs failed — checkpoint NOT advanced, next run retries them\n"); exit(1); }
if ($incremental) {
    @mkdir(dirname($stateFile), 0750, true);
    file_put_contents($stateFile, json_encode(['last_run' => $startedAt]));
}
echo "[export] done\n";
