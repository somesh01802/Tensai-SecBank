<?php
namespace Tensai;

/**
 * Elasticsearch side of the SecBank dashboards (D0-D9 + Canvas). Uses ES_BANK_API_KEY
 * and only ever touches logs-bank.* and bank-* (existing tensai-* indices are untouched).
 *
 *   logs-bank.business-default  data stream, one event per journey step (+ page views,
 *                               branch/ATM activity from the simulator), 30 days (ILM)
 *   bank-branches / bank-journeys / bank-journey-steps / bank-customers
 *                               lookup indices (index.mode: lookup) for ES|QL LOOKUP JOIN
 *   bank-journey-health         per journey, per minute: additive counts + C/A/E/X + JHI, 90 days
 *
 * The health index is written by health() (ES|QL, every minute) rather than an Elastic
 * transform: component X (Core Web Vitals) and C/A/E come from different event kinds and
 * a transform pivots one source; storing the counts keeps every window exactly recomputable.
 */
final class BankExport
{
    public const STREAM = 'logs-bank.business-default';
    public const HEALTH = 'bank-journey-health';
    private const K = 'ES_BANK_API_KEY';

    private const KW = ['type' => 'keyword'];

    /** Explicit mapping of the business event (dynamic:false — unknown fields stay in _source, unmapped). */
    public static function eventMapping(): array
    {
        $kw = self::KW;
        return ['dynamic' => false, 'properties' => [
            '@timestamp' => ['type' => 'date'],
            'data_stream' => ['properties' => ['type' => ['type' => 'constant_keyword'],
                'dataset' => ['type' => 'constant_keyword'], 'namespace' => ['type' => 'constant_keyword']]],
            'message' => ['type' => 'text'],
            'event' => ['properties' => ['dataset' => $kw, 'category' => $kw, 'action' => $kw, 'outcome' => $kw,
                'duration' => ['type' => 'long']]],
            'journey' => ['properties' => ['name' => $kw, 'id' => $kw, 'step' => $kw, 'step_key' => $kw,
                'step_index' => ['type' => 'integer'], 'status' => $kw, 'reason_code' => $kw, 'failure_class' => $kw,
                'duration_ms' => ['type' => 'long'], 'step_duration_ms' => ['type' => 'long']]],
            'bank' => ['properties' => [
                'txn' => ['properties' => ['amount' => ['type' => 'double'], 'currency' => $kw]],
                'channel' => $kw, 'region' => $kw, 'dependency' => $kw,
                'customer' => ['properties' => ['ref' => $kw, 'segment' => $kw]],
                'branch' => ['properties' => ['id' => $kw, 'location' => ['type' => 'geo_point']]],
                'atm' => ['properties' => ['id' => $kw]]]],
            'page' => ['properties' => ['route' => $kw, 'lcp_ms' => ['type' => 'double'], 'inp_ms' => ['type' => 'double'],
                'cls' => ['type' => 'double'], 'vitals_pass' => ['type' => 'boolean']]],
            'trace' => ['properties' => ['id' => $kw]],
            'transaction' => ['properties' => ['id' => $kw]],
            'service' => ['properties' => ['name' => $kw, 'version' => $kw, 'environment' => $kw]],
            'user_agent' => ['properties' => ['name' => $kw, 'device' => ['properties' => ['name' => $kw]]]],
            'http' => ['properties' => ['response' => ['properties' => ['status_code' => ['type' => 'integer']]]]],
            'labels' => ['properties' => ['synthetic_user' => ['type' => 'boolean'], 'data_source' => $kw,
                'session_id' => $kw, 'attempt_id' => $kw]],
        ]];
    }

    private const LOOKUPS = [
        'bank-branches' => ['bank.branch.id' => 'keyword', 'bank.branch.name' => 'keyword', 'bank.region' => 'keyword',
            'bank.branch.location' => 'geo_point', 'bank.branch.atm_count' => 'integer'],
        'bank-journeys' => ['journey.name' => 'keyword', 'journey.label' => 'keyword',
            'journey.slo_completion_pct' => 'double', 'journey.p95_target_ms' => 'long'],
        'bank-journey-steps' => ['journey.step_key' => 'keyword', 'journey.name' => 'keyword', 'journey.step' => 'keyword',
            'journey.step_index' => 'integer', 'journey.step_label' => 'keyword', 'journey.step_target_ms' => 'long',
            'journey.step_services' => 'keyword', 'journey.step_is_final' => 'boolean'],
        'bank-customers' => ['bank.customer.ref' => 'keyword', 'bank.customer.segment' => 'keyword', 'bank.region' => 'keyword',
            'bank.branch.id' => 'keyword', 'labels.synthetic_user' => 'boolean', 'labels.data_source' => 'keyword'],
    ];

    private const HEALTH_FIELDS = ['@timestamp' => 'date', 'journey.name' => 'keyword', 'labels.synthetic_user' => 'boolean',
        'health.attempts' => 'long', 'health.completed' => 'long', 'health.tech_failures' => 'long',
        'health.satisfied' => 'long', 'health.tolerating' => 'long', 'health.page_views' => 'long',
        'health.page_views_pass' => 'long', 'health.value_failed' => 'double', 'health.slo_completion_pct' => 'double',
        'health.c' => 'double', 'health.a' => 'double', 'health.e' => 'double', 'health.x' => 'double',
        'health.x_source' => 'keyword', 'health.index' => 'double', 'health.band' => 'keyword'];

    /** "a.b.c" => type  ->  nested properties tree. */
    public static function props(array $flat): array
    {
        $out = [];
        foreach ($flat as $path => $type) {
            $ref = &$out;
            foreach (explode('.', $path) as $i => $part) {
                $last = $i === substr_count($path, '.');
                if ($last) { $ref[$part] = ['type' => $type]; break; }
                $ref[$part]['properties'] ??= [];
                $ref = &$ref[$part]['properties'];
            }
            unset($ref);
        }
        return $out;
    }

    /** Create or (additively) update an index. Never deletes or changes an existing field. */
    private static function ensureIndex(string $index, array $mappings, array $settings = []): void
    {
        [$code, $j] = Es::req('PUT', '/' . $index, ['settings' => $settings ?: new \stdClass(), 'mappings' => $mappings], self::K);
        if ($code < 300) { echo "  created $index\n"; return; }
        if (($j['error']['type'] ?? '') !== 'resource_already_exists_exception')
            throw new \RuntimeException("create $index HTTP $code: " . json_encode($j['error'] ?? $j));
        Es::ok('PUT', "/$index/_mapping", $mappings);
        echo "  $index exists, mapping updated additively\n";
    }

    /** Idempotent one-time setup: ILM, template, data stream, lookups (seeded from Postgres), health index. */
    public static function setup(): void
    {
        Es::ok('PUT', '/_ilm/policy/bank-business-30d', ['policy' => ['phases' => [
            'hot' => ['actions' => ['rollover' => ['max_age' => '1d', 'max_primary_shard_size' => '10gb']]],
            'delete' => ['min_age' => '30d', 'actions' => ['delete' => new \stdClass()]]]]]);
        echo "  ILM policy bank-business-30d (rollover 1d, delete after 30d)\n";
        // Priority 500 beats the built-in logs-*-* template (100) for this dataset only.
        Es::ok('PUT', '/_index_template/logs-bank.business', [
            'index_patterns' => ['logs-bank.business-*'], 'data_stream' => new \stdClass(), 'priority' => 500,
            '_meta' => ['owner' => 'tensai-secbank', 'description' => 'SecBank business journey events'],
            'template' => ['settings' => ['index.lifecycle.name' => 'bank-business-30d', 'number_of_shards' => 1],
                'mappings' => self::eventMapping()]]);
        echo "  index template logs-bank.business\n";
        [$code, $j] = Es::req('PUT', '/_data_stream/' . self::STREAM, '', self::K);
        if ($code >= 300 && ($j['error']['type'] ?? '') !== 'resource_already_exists_exception')
            throw new \RuntimeException('create data stream HTTP ' . $code . ': ' . json_encode($j['error'] ?? $j));
        // Push later field additions to the current backing index too (data_stream.* constants are fixed at creation).
        $m = self::eventMapping();
        unset($m['properties']['data_stream']);
        Es::ok('PUT', '/' . self::STREAM . '/_mapping', $m);
        echo '  data stream ' . self::STREAM . "\n";

        foreach (self::LOOKUPS as $index => $fields)
            self::ensureIndex($index, ['dynamic' => false, 'properties' => self::props($fields)], ['index.mode' => 'lookup']);
        self::ensureIndex(self::HEALTH, ['dynamic' => false, 'properties' => self::props(self::HEALTH_FIELDS)],
            ['number_of_shards' => 1]);
        self::seedLookups();
    }

    private static function seedLookups(): void
    {
        $f = 0;
        $f += Es::bulk('bank-branches', array_map(fn($b) => [$b['id'], ['bank' => [
            'branch' => ['id' => $b['id'], 'name' => $b['name'], 'atm_count' => (int) $b['atmCount'],
                'location' => ['lat' => (float) $b['latitude'], 'lon' => (float) $b['longitude']]],
            'region' => $b['region']]]],
            Db::all('SELECT b.*, r.name AS region FROM bank_branches b JOIN bank_regions r ON r.id = b.region_id')), false, self::K);
        $f += Es::bulk('bank-journeys', array_map(fn($j) => [$j['name'], ['journey' => ['name' => $j['name'],
            'label' => $j['label'], 'slo_completion_pct' => (float) $j['sloCompletionPct'], 'p95_target_ms' => (int) $j['p95TargetMs']]]],
            Db::all('SELECT * FROM bank_journeys')), false, self::K);
        $f += Es::bulk('bank-journey-steps', array_map(fn($s) => [$s['journey'] . ':' . $s['step'], ['journey' => [
            'step_key' => $s['journey'] . ':' . $s['step'], 'name' => $s['journey'], 'step' => $s['step'],
            'step_index' => (int) $s['stepIndex'], 'step_label' => $s['label'], 'step_target_ms' => (int) $s['targetMs'],
            'step_services' => array_map('trim', explode(',', $s['services'])), 'step_is_final' => (bool) $s['isFinal']]]],
            Db::all('SELECT * FROM bank_journey_steps')), false, self::K);
        if ($f) throw new \RuntimeException("$f lookup docs failed");
        echo "  lookups seeded: branches, journeys, journey steps\n";
    }

    /**
     * Pseudonymous customer reference shown on dashboards: "C-" + 6 hex of the keyed user_ref.
     * ponytail: 24 bits -> ~1 expected collision among 5k users (they share a lookup row); widen if users grow 10x.
     */
    public static function customerRef(?string $userId): ?string
    {
        $r = Apm::userRef($userId);
        return $r ? 'C-' . strtoupper(substr($r, 2, 6)) : null;
    }

    /** Infrastructure failure category -> third-party dependency (spec bank.dependency vocabulary). */
    public static function dependency(?string $category, ?string $kind): ?string
    {
        return match ($category) {
            'processor_timeout', 'network_failure', 'service_outage' => $kind === 'CARD' ? 'card_processor' : 'payment_gw',
            'fraud_timeout' => 'fraud_engine',
            default => null,
        };
    }

    /** journey_events -> data stream. $since = SQL timestamptz expression or null (full). Returns #failed. */
    public static function events(?string $since, bool $dry = false): int
    {
        $rows = Db::all("
            SELECT e.*, u.segment, r.name AS region, a.error_category, a.kind
            FROM journey_events e
            LEFT JOIN users u ON u.id = e.user_id
            LEFT JOIN bank_branches b ON b.id = u.home_branch_id
            LEFT JOIN bank_regions r ON r.id = b.region_id
            LEFT JOIN transaction_attempts a ON a.id = e.attempt_id
            WHERE " . ($since ? "e.created_at >= ($since)" : 'TRUE') . ' ORDER BY e.id');
        $docs = array_map(fn($e) => ['je-' . $e['id'], self::eventDoc($e)], $rows);
        if ($dry) { echo '  sample event: ' . json_encode($docs[0][1] ?? null, JSON_UNESCAPED_SLASHES) . "\n"; return 0; }
        $f = $docs ? Es::bulk(self::STREAM, $docs, true, self::K) : 0;
        printf("[export] %-26s %7d docs%s\n", self::STREAM, count($docs), $f ? " ($f FAILED)" : '');
        return $f;
    }

    public static function eventDoc(array $e): array
    {
        $fail = $e['outcome'] === 'failure';
        return [
            '@timestamp' => (new \DateTimeImmutable($e['createdAt']))->format('Y-m-d\TH:i:s.vP'),
            'event' => ['dataset' => 'bank.business', 'category' => 'journey', 'action' => $e['step'],
                'outcome' => $e['outcome'], 'duration' => $e['durationMs'] !== null ? (int) $e['durationMs'] * 1000000 : null],
            'journey' => ['name' => $e['journey'], 'id' => $e['journeyId'], 'step' => $e['step'],
                'step_key' => $e['journey'] . ':' . $e['step'], 'step_index' => (int) $e['stepIndex'], 'status' => $e['status'],
                'reason_code' => $e['reasonCode'], 'failure_class' => $e['failureClass'],
                'duration_ms' => $e['journeyDurationMs'] !== null ? (int) $e['journeyDurationMs'] : null,
                'step_duration_ms' => $e['durationMs'] !== null ? (int) $e['durationMs'] : null],
            'bank' => ['txn' => ['amount' => $e['amount'] !== null ? (float) $e['amount'] : null, 'currency' => $e['currency']],
                'channel' => $e['channel'], 'region' => $e['region'],
                'dependency' => $fail ? self::dependency($e['errorCategory'], $e['kind']) : null,
                'customer' => ['ref' => self::customerRef($e['userId']), 'segment' => $e['segment']]],
            'trace' => ['id' => $e['traceId']],
            'service' => ['name' => 'tensai-secbank-api', 'environment' => 'production'],
            'user_agent' => ['name' => $e['browser'], 'device' => ['name' => $e['device']]],
            'http' => ['response' => ['status_code' => $e['httpStatus'] !== null ? (int) $e['httpStatus'] : null]],
            'labels' => ['synthetic_user' => (bool) $e['isSynthetic'], 'data_source' => 'app',
                'session_id' => $e['sessionId'], 'attempt_id' => $e['attemptId']],
        ];
    }

    /** Users -> bank-customers lookup (ref, segment, region, branch; no name/email/phone). */
    public static function customers(?string $since, bool $dry = false): int
    {
        $rows = Db::all("
            SELECT u.id, u.segment, u.home_branch_id, u.is_synthetic, r.name AS region
            FROM users u LEFT JOIN bank_branches b ON b.id = u.home_branch_id LEFT JOIN bank_regions r ON r.id = b.region_id
            WHERE " . ($since ? "u.created_at >= ($since) OR u.updated_at >= ($since)" : 'TRUE'));
        $docs = array_map(fn($u) => [self::customerRef($u['id']), ['bank' => [
            'customer' => ['ref' => self::customerRef($u['id']), 'segment' => $u['segment']],
            'region' => $u['region'], 'branch' => ['id' => $u['homeBranchId']]],
            'labels' => ['synthetic_user' => (bool) $u['isSynthetic'], 'data_source' => 'app']]], $rows);
        if ($dry) return 0;
        $f = $docs ? Es::bulk('bank-customers', $docs, false, self::K) : 0;
        printf("[export] %-26s %7d docs%s\n", 'bank-customers', count($docs), $f ? " ($f FAILED)" : '');
        return $f;
    }

    /** Journey health index per journey, per minute, real and synthetic separately. Recomputes the last $minutes. */
    public static function health(int $minutes = 5): int
    {
        $from = "DATE_TRUNC(1 minute, NOW() - $minutes minutes)";
        $rows = Es::esql('FROM ' . self::STREAM . "
            | WHERE @timestamp >= $from AND event.category == \"journey\" AND journey.status IN (\"completed\", \"failed\", \"abandoned\")
            | EVAL minute = DATE_TRUNC(1 minute, @timestamp),
                   done = CASE(journey.status == \"completed\", 1, 0),
                   tech = CASE(journey.failure_class == \"technical\", 1, 0),
                   sat = CASE(journey.status == \"completed\" AND journey.duration_ms <= 10000, 1, 0),
                   tol = CASE(journey.status == \"completed\" AND journey.duration_ms > 10000 AND journey.duration_ms <= 40000, 1, 0),
                   vf = CASE(journey.failure_class == \"technical\", bank.txn.amount, 0.0)
            | STATS attempts = COUNT(*), completed = SUM(done), tech_failures = SUM(tech), satisfied = SUM(sat),
                    tolerating = SUM(tol), value_failed = SUM(vf) BY journey.name, labels.synthetic_user, minute");
        $views = [];
        foreach (Es::esql('FROM ' . self::STREAM . "
            | WHERE @timestamp >= $from AND event.category == \"page_view\"
            | EVAL minute = DATE_TRUNC(1 minute, @timestamp), ok = CASE(page.vitals_pass, 1, 0)
            | STATS views = COUNT(*), pass = SUM(ok) BY journey.name, labels.synthetic_user, minute") as $v)
            $views[$v['journey.name'] . '|' . json_encode($v['labels.synthetic_user']) . '|' . $v['minute']] = $v;
        $slo = array_column(Db::all('SELECT name, slo_completion_pct FROM bank_journeys'), 'sloCompletionPct', 'name');

        $docs = [];
        foreach ($rows as $r) {
            if (!isset($slo[$r['journey.name']]) || !$r['attempts']) continue;
            $key = $r['journey.name'] . '|' . json_encode($r['labels.synthetic_user']) . '|' . $r['minute'];
            $docs[] = [md5($key), self::healthDoc($r, (float) $slo[$r['journey.name']], $views[$key] ?? null)];
        }
        $f = $docs ? Es::bulk(self::HEALTH, $docs, false, self::K) : 0;
        // Retention: 90 days (plain index, so per-document cleanup instead of ILM index deletion).
        Es::req('POST', '/' . self::HEALTH . '/_delete_by_query?conflicts=proceed&wait_for_completion=false',
            ['query' => ['range' => ['@timestamp' => ['lt' => 'now-90d']]]], self::K);
        printf("[health] %-26s %7d docs%s\n", self::HEALTH, count($docs), $f ? " ($f FAILED)" : '');
        return $f;
    }

    /** JHI = 100 x (0.40 C + 0.25 A + 0.20 E + 0.15 X) — spec formula, bands 90 / 80. */
    public static function healthDoc(array $r, float $sloPct, ?array $views): array
    {
        $n = (int) $r['attempts'];
        $c = min(1.0, ((int) $r['completed'] / $n) / ($sloPct / 100));
        $a = ((int) $r['satisfied'] + (int) $r['tolerating'] / 2) / $n;
        $e = max(0.0, 1 - ((int) $r['tech_failures'] / $n) / 0.05);
        // ponytail: no page views in the minute -> X = 1 (no evidence of a bad experience), flagged by x_source.
        $x = ($views && $views['views']) ? (int) $views['pass'] / (int) $views['views'] : 1.0;
        $jhi = round(100 * (0.40 * $c + 0.25 * $a + 0.20 * $e + 0.15 * $x), 1);
        return [
            '@timestamp' => $r['minute'], 'journey' => ['name' => $r['journey.name']],
            'labels' => ['synthetic_user' => (bool) $r['labels.synthetic_user']],
            'health' => ['attempts' => $n, 'completed' => (int) $r['completed'], 'tech_failures' => (int) $r['tech_failures'],
                'satisfied' => (int) $r['satisfied'], 'tolerating' => (int) $r['tolerating'],
                'page_views' => (int) ($views['views'] ?? 0), 'page_views_pass' => (int) ($views['pass'] ?? 0),
                'value_failed' => (float) $r['value_failed'], 'slo_completion_pct' => $sloPct,
                'c' => round($c, 4), 'a' => round($a, 4), 'e' => round($e, 4), 'x' => round($x, 4),
                'x_source' => $views ? 'page_views' : 'none', 'index' => $jhi,
                'band' => $jhi >= 90 ? 'healthy' : ($jhi >= 80 ? 'watch' : 'critical')],
        ];
    }
}
