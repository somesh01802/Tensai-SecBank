<?php
namespace Tensai;

/**
 * Problem detection for the wallboard and the Incident Room, from signals only (never the ledger).
 * Runs every minute after the health job (bin/journey-health.php) and can replay past minutes after a backfill.
 *
 *   bank-problems      one document per problem: open -> closed, impact since it started
 *   bank-problem-rank  the wallboard's four slots (severity, then value at risk; free slots show the next risk) + a summary row
 *   bank-risks         predictable risks: certificate expiry (TLS monitor), memory forecast (linear fit)
 *
 * Detectors (thresholds are the Plan's: 5 % technical-failure ceiling, severity targets 30/45/60 min):
 *   journey_failure  technical failures >= 5 % of a journey's attempts over 10 min (>= 10 failures);
 *                    failures >= 70 % in one region become one regional problem across journeys (blast radius)
 *   reason_shift     one business decline reason at >= 3x its baseline rate (declines that are not the customer's fault)
 *   volume_drop      autopay runs below 60 % of the 6-hour p75 per minute, with no errors (technology green, business red)
 *   branch_dark      a branch with >= 0.5 events/min stops emitting for 5 min
 * A problem closes after 5 minutes without its signal.
 */
final class Problems
{
    public const INDEX = 'bank-problems';
    public const RANK = 'bank-problem-rank';
    public const RISKS = 'bank-risks';
    private const SRC = BankExport::STREAM;
    private const K = 'ES_BANK_API_KEY';
    public const SEVERITY = ['critical' => 1, 'major' => 2, 'minor' => 3];
    public const TARGET_MIN = ['critical' => 30, 'major' => 45, 'minor' => 60];
    private const TERMINAL = '("completed", "failed", "abandoned", "pending")';

    public static function mappings(): array
    {
        $p = ['@timestamp' => 'date', 'problem.id' => 'keyword', 'problem.key' => 'keyword', 'problem.status' => 'keyword',
            'problem.severity' => 'keyword', 'problem.severity_rank' => 'integer', 'problem.kind' => 'keyword', 'problem.title' => 'keyword',
            'problem.owner' => 'keyword', 'problem.started_at' => 'date', 'problem.detected_at' => 'date', 'problem.last_seen_at' => 'date',
            'problem.ended_at' => 'date', 'problem.age_target_min' => 'integer', 'problem.open_min' => 'double',
            'journey.name' => 'keyword', 'journey.reason_code' => 'keyword', 'bank.region' => 'keyword', 'bank.branch.id' => 'keyword',
            'bank.dependency' => 'keyword', 'service.name' => 'keyword',
            'impact.customers' => 'long', 'impact.customers_estimated' => 'boolean', 'impact.failures' => 'long',
            'impact.value_failed' => 'double', 'impact.value_delayed' => 'double', 'impact.value_at_risk' => 'double',
            'case.id' => 'keyword', 'labels.data_source' => 'keyword'];
        $r = ['@timestamp' => 'date', 'risk.key' => 'keyword', 'risk.type' => 'keyword', 'risk.title' => 'keyword', 'risk.component' => 'keyword',
            'risk.owner' => 'keyword', 'risk.source' => 'keyword', 'risk.status' => 'keyword', 'risk.due_at' => 'date', 'risk.days_left' => 'double',
            'risk.confidence' => 'double', 'risk.first_seen_at' => 'date', 'service.name' => 'keyword', 'labels.data_source' => 'keyword'];
        $rank = $p + $r + ['slot' => 'integer', 'kind' => 'keyword', 'summary.open' => 'integer', 'summary.critical' => 'integer',
            'summary.major' => 'integer', 'summary.minor' => 'integer', 'summary.overflow' => 'integer', 'summary.overflow_critical' => 'integer',
            'summary.overflow_major' => 'integer', 'summary.overflow_minor' => 'integer', 'summary.risks' => 'integer'];
        return [self::INDEX => $p, self::RISKS => $r, self::RANK => $rank];
    }

    private static function t(int $ts): string { return 'TO_DATETIME("' . gmdate('Y-m-d\TH:i:s', $ts) . '.000Z")'; }
    private static function iso(int $ts): string { return gmdate('Y-m-d\TH:i:s', $ts) . '.000Z'; }
    private static function ts(string $iso): int { return (int) strtotime($iso); }

    /**
     * Detect as of $now for every minute in [$from, $now] (replay), then write problems, rank and risks once.
     * Open problems are loaded from bank-problems so lifecycles continue across runs.
     */
    public static function run(int $now, int $from = 0): int
    {
        $now = intdiv($now, 60) * 60;
        $open = [];
        foreach (Es::esql('FROM ' . self::INDEX . ' | WHERE problem.status == "open" | LIMIT 1000') as $d) $open[$d['problem.key']] = self::unflat($d);
        $done = [];
        for ($t = $from ? intdiv($from, 60) * 60 : $now; $t <= $now; $t += 60) self::step($t, $open, $done);
        $risks = self::risks($now);
        $docs = array_map(fn($p) => [$p['problem']['id'], $p], array_merge(array_values($open), $done));
        $f = $docs ? Es::bulk(self::INDEX, $docs, false, self::K) : 0;
        $f += $risks ? Es::bulk(self::RISKS, array_map(fn($r) => [$r['risk']['key'], $r], $risks), false, self::K) : 0;
        $f += Es::bulk(self::RANK, self::rank($now, $open, $risks), false, self::K);
        printf("[problems] open %d, closed %d, risks %d%s\n", count($open), count($done), count(array_filter($risks, fn($r) => $r['risk']['status'] === 'open')), $f ? " ($f FAILED)" : '');
        return $f;
    }

    /** ES|QL returns dotted column names; rebuild the nested document. */
    private static function unflat(array $row): array
    {
        $out = [];
        foreach ($row as $k => $v) {
            if ($v === null) continue;
            $ref = &$out;
            foreach (explode('.', $k) as $part) $ref = &$ref[$part];
            $ref = $v;
            unset($ref);
        }
        return $out;
    }

    private static function step(int $now, array &$open, array &$done): void
    {
        $found = array_merge(self::journeyFailures($now), self::reasonShifts($now), self::volumeDrops($now), self::darkBranches($now));
        foreach ($found as $key => $c) {
            $p = $open[$key] ?? null;
            if (!$p) {
                $p = ['problem' => ['id' => 'PRB-' . strtoupper(substr(md5("$key|$now"), 0, 6)), 'key' => $key, 'status' => 'open',
                    'detected_at' => self::iso($now), 'started_at' => $c['started_at']], 'case' => ['id' => null], 'labels' => ['data_source' => 'detector']];
            }
            $start = min(self::ts($p['problem']['started_at']), self::ts($c['started_at']));
            $sev = $c['severity'];
            // Severity never drops while a problem is open.
            if (isset($p['problem']['severity']) && self::SEVERITY[$p['problem']['severity']] < self::SEVERITY[$sev]) $sev = $p['problem']['severity'];
            $p['@timestamp'] = self::iso($start);
            $p['problem'] = array_merge($p['problem'], ['severity' => $sev, 'severity_rank' => self::SEVERITY[$sev], 'kind' => $c['kind'],
                'title' => $c['title'], 'owner' => $c['owner'], 'started_at' => self::iso($start), 'last_seen_at' => self::iso($now),
                'age_target_min' => self::TARGET_MIN[$sev], 'open_min' => round(($now - self::ts($p['problem']['detected_at'])) / 60, 1)]);
            foreach (['journey', 'bank', 'service'] as $k) if (isset($c[$k])) $p[$k] = $c[$k];
            $p['impact'] = $c['impact'] + ['value_at_risk' => round(($c['impact']['value_failed'] ?? 0) + ($c['impact']['value_delayed'] ?? 0), 2)];
            $open[$key] = $p;
        }
        foreach ($open as $key => $p)
            if (!isset($found[$key]) && $now - self::ts($p['problem']['last_seen_at']) >= 300) {
                $p['problem']['status'] = 'closed';
                $p['problem']['ended_at'] = $p['problem']['last_seen_at'];
                $done[] = $p;
                unset($open[$key]);
            }
    }

    /** Owner from the evidence (dependency / service / component), never from the ledger. */
    private static function owner(?string $dep, ?string $svc, string $kind): string
    {
        return match (true) {
            $kind === 'branch_dark' => 'Branch network team',
            in_array($dep, ['payment_gw', 'card_processor'], true), in_array($svc, ['payments-svc', 'transfers-svc', 'cards-svc'], true) => 'Payments on-call',
            $dep === 'sms_otp', $svc === 'auth-svc' => 'Identity on-call',
            default => 'Digital on-call',
        };
    }

    private static function label(string $j): string { return ucfirst(str_replace('_', ' ', $j)); }

    /** Walk back from the newest minute while $bad(minute) holds, tolerating gaps of up to 2 minutes. Returns the first bad minute. */
    private static function since(array $byMinute, callable $bad, int $now): ?int
    {
        $start = null; $gap = 0;
        for ($m = $now - 60; $m >= $now - 3600; $m -= 60) {
            if ($bad($byMinute[$m] ?? null)) { $start = $m; $gap = 0; }
            elseif (++$gap > 2) break;
        }
        return $start;
    }

    private static function journeyFailures(int $now): array
    {
        $by = [];
        foreach (Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($now - 3600) . ' AND @timestamp < ' . self::t($now)
            . ' AND event.category == "journey" AND journey.status IN ' . self::TERMINAL . '
            | EVAL m = DATE_TRUNC(1 minute, @timestamp), tech = CASE(journey.failure_class == "technical", 1, 0)
            | STATS n = COUNT(*), tech = SUM(tech) BY journey.name, m') as $r)
            $by[$r['journey.name']][self::ts($r['m'])] = [(int) $r['n'], (int) $r['tech']];
        $groups = [];
        foreach ($by as $j => $mins) {
            [$n, $tech] = [0, 0];
            foreach ($mins as $m => [$a, $b]) if ($m >= $now - 600) { $n += $a; $tech += $b; }
            if ($tech < 10 || $tech / max(1, $n) < 0.05) continue;
            $start = self::since($mins, fn($x) => $x && $x[1] >= 1 && $x[1] / $x[0] >= 0.05, $now) ?? $now - 600;
            $where = 'journey.name == "' . $j . '" AND journey.failure_class == "technical"';
            // Concentration over the same window that triggered (>= 10 failures), so the first detection already groups by region.
            $regions = Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t(min($start, $now - 600)) . ' AND @timestamp < ' . self::t($now) . " AND $where
                | STATS n = COUNT(*) BY bank.region | SORT n DESC");
            $total = array_sum(array_column($regions, 'n'));
            $top = $regions[0] ?? ['n' => 0, 'bank.region' => null];
            $ev = Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($start) . ' AND @timestamp < ' . self::t($now) . " AND $where
                | STATS n = COUNT(*) BY journey.reason_code, bank.dependency, service.name | SORT n DESC | LIMIT 1")[0] ?? [];
            $regional = $total >= 10 && $top['bank.region'] && $top['n'] / $total >= 0.7;
            $key = $regional ? "region:{$top['bank.region']}:{$ev['journey.reason_code']}" : "journey:$j";
            $g = $groups[$key] ?? ['journeys' => [], 'start' => $start, 'share' => 0, 'ev' => $ev, 'region' => $regional ? $top['bank.region'] : null];
            $g['journeys'][] = $j;
            $g['start'] = min($g['start'], $start);
            $g['share'] = max($g['share'], $tech / $n);
            $groups[$key] = $g;
        }
        $out = [];
        foreach ($groups as $key => $g) {
            $js = '("' . implode('", "', $g['journeys']) . '")';
            $where = "journey.name IN $js AND journey.failure_class == \"technical\"" . ($g['region'] ? " AND bank.region == \"{$g['region']}\"" : '');
            $imp = Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($g['start']) . ' AND @timestamp < ' . self::t($now) . " AND $where
                | STATS customers = COUNT_DISTINCT(bank.customer.ref), failures = COUNT(*),
                        failed = SUM(CASE(journey.status == \"failed\", bank.txn.amount, 0.0)), pending = SUM(CASE(journey.status == \"pending\", bank.txn.amount, 0.0))")[0];
            $ev = $g['ev'];
            $dep = $ev['bank.dependency'] ?? null;
            $reason = $ev['journey.reason_code'] ?? null;
            $out[$key] = ['kind' => 'journey_failure', 'started_at' => self::iso($g['start']),
                // Regional faults have a bounded blast radius: major at most.
                'severity' => !$g['region'] && $g['share'] >= 0.15 ? 'critical' : 'major',
                'title' => $g['region'] ? str_replace('_', ' ', (string) $reason) . " in the {$g['region']}: " . implode(', ', array_map([self::class, 'label'], $g['journeys']))
                    : self::label($g['journeys'][0]) . ' failing: ' . str_replace('_', ' ', (string) $reason) . ($dep ? " ($dep)" : ''),
                'owner' => self::owner($dep, $ev['service.name'] ?? null, 'journey_failure'),
                'journey' => ['name' => $g['journeys'], 'reason_code' => $reason], 'service' => ['name' => $ev['service.name'] ?? null],
                'bank' => ['region' => $g['region'], 'dependency' => $dep],
                'impact' => ['customers' => (int) $imp['customers'], 'customers_estimated' => false, 'failures' => (int) $imp['failures'],
                    'value_failed' => round((float) $imp['failed'], 2), 'value_delayed' => round((float) $imp['pending'], 2)]];
        }
        return $out;
    }

    private static function reasonShifts(int $now): array
    {
        $by = [];
        foreach (Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($now - 3600) . ' AND @timestamp < ' . self::t($now)
            . ' AND journey.failure_class == "business" | EVAL m = DATE_TRUNC(1 minute, @timestamp)
            | STATS n = COUNT(*) BY journey.name, journey.reason_code, m') as $r)
            $by[$r['journey.name'] . '|' . $r['journey.reason_code']][self::ts($r['m'])] = (int) $r['n'];
        $out = [];
        foreach ($by as $k => $mins) {
            // Baseline: per minute over up to 50 min before the last 10; needs >= 30 min of history.
            $history = min(50, ($now - 600 - self::firstData($now)) / 60);
            if ($history < 30) continue;
            $recent = array_sum(array_filter($mins, fn($m) => $m >= $now - 600, ARRAY_FILTER_USE_KEY));
            $base = array_sum(array_filter($mins, fn($m) => $m < $now - 600, ARRAY_FILTER_USE_KEY)) / $history;
            if ($recent < 20 || $recent / 10 < 4 * max($base, 0.2)) continue;
            [$j, $reason] = explode('|', $k);
            $start = self::since($mins, fn($x) => $x !== null && $x >= max(2, 4 * $base), $now) ?? $now - 600;
            $imp = Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($start) . ' AND @timestamp < ' . self::t($now)
                . " AND journey.name == \"$j\" AND journey.reason_code == \"$reason\"
                | STATS customers = COUNT_DISTINCT(bank.customer.ref), failures = COUNT(*), failed = SUM(bank.txn.amount)")[0];
            $out["journey:$j:reason:$reason"] = ['kind' => 'reason_shift', 'started_at' => self::iso($start), 'severity' => 'major',
                'title' => self::label($j) . ': ' . str_replace('_', ' ', $reason) . ' declines ' . round($recent / 10 / max($base, 0.1), 1) . 'x normal',
                'owner' => self::owner(null, $j === 'card_payment' ? 'cards-svc' : null, 'reason_shift'),
                'journey' => ['name' => [$j], 'reason_code' => $reason],
                'impact' => ['customers' => (int) $imp['customers'], 'customers_estimated' => false, 'failures' => (int) $imp['failures'],
                    'value_failed' => round((float) $imp['failed'], 2), 'value_delayed' => 0.0]];
        }
        return $out;
    }

    /** Earliest business event, cached per process (a fresh backfill has no history before it). */
    private static function firstData(int $now): int
    {
        static $first = null;
        return $first ??= self::ts(Es::esql('FROM ' . self::SRC . ' | STATS t = MIN(@timestamp)')[0]['t'] ?? self::iso($now));
    }

    private static function volumeDrops(int $now): array
    {
        $mins = [];
        foreach (Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($now - 21600) . ' AND @timestamp < ' . self::t($now)
            . ' AND event.category == "autopay_run" | STATS n = COUNT(*), v = SUM(bank.txn.amount) BY m = DATE_TRUNC(1 minute, @timestamp)') as $r)
            $mins[self::ts($r['m'])] = [(int) $r['n'], (float) $r['v']];
        $older = array_column(array_filter($mins, fn($m) => $m < $now - 900, ARRAY_FILTER_USE_KEY), 0);
        if (count($older) < 10) return [];
        sort($older);
        $p75 = $older[(int) floor(0.75 * (count($older) - 1))];
        $recent = 0;
        for ($m = $now - 600; $m < $now; $m += 60) $recent += $mins[$m][0] ?? 0;
        $recent /= 10;
        if ($p75 < 5 || $recent >= 0.6 * $p75) return [];
        $start = self::since($mins, fn($x) => ($x[0] ?? 0) < 0.6 * $p75, $now) ?? $now - 600;
        $avg = array_sum(array_column($mins, 1)) / max(1, array_sum(array_column($mins, 0)));
        $missing = 0;
        for ($m = $start; $m < $now; $m += 60) $missing += max(0, $p75 - ($mins[$m][0] ?? 0));
        return ['volume:autopay_run' => ['kind' => 'volume_drop', 'started_at' => self::iso($start), 'severity' => 'major',
            'title' => 'Autopay runs down ' . round(100 * (1 - $recent / $p75)) . '% (' . round($recent) . "/min vs $p75), no errors",
            // Attached to the Autopay setup tile: its health index stays green while scheduled runs quietly drop.
            'owner' => 'Payments on-call', 'service' => ['name' => 'transfers-svc'], 'journey' => ['name' => ['autopay_setup']],
            'impact' => ['customers' => (int) $missing, 'customers_estimated' => true, 'failures' => 0,
                'value_failed' => 0.0, 'value_delayed' => round($missing * $avg, 2)]]];
    }

    private static function darkBranches(int $now): array
    {
        $out = [];
        foreach (Es::esql('FROM ' . self::SRC . ' | WHERE @timestamp >= ' . self::t($now - 21600) . ' AND @timestamp < ' . self::t($now)
            . ' AND bank.channel IN ("branch", "atm") AND bank.branch.id IS NOT NULL
            | STATS n = COUNT(*), v = SUM(CASE(journey.name IN ("bill_pay", "p2p_transfer") AND journey.status IS NOT NULL, bank.txn.amount, 0.0)), first_at = MIN(@timestamp), last_at = MAX(@timestamp)
                BY bank.branch.id, bank.region') as $r) {
            // Value delayed = bill payments and transfers normally made at the branch; teller cash and loan applications are not.
            $first = self::ts($r['first_at']); $last = self::ts($r['last_at']);
            $rate = $r['n'] / max(1, ($last - $first) / 60);
            if ($last >= $now - 300 || $rate < 2 || $last - $first < 1800) continue;
            $dark = ($now - $last) / 60;
            $out['branch:' . $r['bank.branch.id']] = ['kind' => 'branch_dark', 'started_at' => self::iso($last), 'severity' => 'minor',
                'title' => "Branch {$r['bank.branch.id']} not transacting (teller and ATM), " . round($dark) . ' min',
                'owner' => 'Branch network team', 'bank' => ['branch' => ['id' => $r['bank.branch.id']], 'region' => $r['bank.region']],
                'impact' => ['customers' => null, 'customers_estimated' => true, 'failures' => 0, 'value_failed' => 0.0,
                    'value_delayed' => round((float) $r['v'] / max(1, ($last - $first) / 60) * $dark, 2)]];
        }
        return $out;
    }

    /** Predictable risks as of $now: certificates expiring within 30 days, pod memory projected to hit its limit within 24 h. */
    private static function risks(int $now): array
    {
        $out = [];
        $seen = [];
        foreach (Es::esql('FROM logs-bank.synthetics-default | WHERE @timestamp >= ' . self::t($now - 3600) . ' AND @timestamp < ' . self::t($now)
            . ' AND tls.server.x509.not_after IS NOT NULL | SORT @timestamp DESC
            | KEEP monitor.id, monitor.name, bank.dependency, tls.server.x509.not_after, tls.server.x509.subject.common_name | LIMIT 100') as $r) {
            if (isset($seen[$r['monitor.id']])) continue;
            $seen[$r['monitor.id']] = true;
            $days = (self::ts($r['tls.server.x509.not_after']) - $now) / 86400;
            $out[] = self::risk("certificate:{$r['monitor.id']}", 'certificate', "{$r['bank.dependency']} certificate expires in " . round($days, 1) . ' days',
                "{$r['bank.dependency']} certificate", 'Payments on-call', 'Synthetics TLS', $r['tls.server.x509.not_after'], $days, 1.0, $days < 30, $now, 'payments-svc');
        }
        $pods = [];
        foreach (Es::esql('FROM metrics-bank.platform-default | WHERE @timestamp >= ' . self::t($now - 3600) . ' AND @timestamp < ' . self::t($now)
            . ' AND metricset.name == "pod" | STATS mem = AVG(kubernetes.pod.memory.pct) BY service.name, kubernetes.pod.name, b = DATE_TRUNC(5 minutes, @timestamp)') as $r)
            $pods[$r['service.name']][$r['kubernetes.pod.name']][self::ts($r['b'])] = (float) $r['mem'];
        foreach ($pods as $svc => $ps) {
            $worst = null;
            foreach ($ps as $series) {
                if (count($series) < 6) continue;
                [$slope, $r2] = self::fit($series);
                $lastT = max(array_keys($series));
                $eta = $slope > 0 ? (1.0 - $series[$lastT]) / $slope : INF;   // seconds to 100 % of the limit
                if ($r2 >= 0.8 && $eta < 86400 && (!$worst || $eta < $worst[0])) $worst = [$eta, $r2];
            }
            $key = "capacity:$svc:memory";
            $out[] = $worst ? self::risk($key, 'capacity', "$svc memory reaches its limit in about " . round($worst[0] / 3600, 1) . ' h', "$svc memory",
                    self::owner(null, $svc, 'capacity'), 'Linear forecast on pod memory (ML forecast in Kibana)', self::iso($now + (int) $worst[0]), $worst[0] / 86400, round($worst[1], 2), true, $now, $svc)
                : self::risk($key, 'capacity', "$svc memory", "$svc memory", '', '', null, null, null, false, $now, $svc);
        }
        return $out;
    }

    private static function risk(string $key, string $type, string $title, string $comp, string $owner, string $source, ?string $due, ?float $days, ?float $conf, bool $open, int $now, string $svc): array
    {
        return ['@timestamp' => self::iso($now), 'risk' => ['key' => $key, 'type' => $type, 'title' => $title, 'component' => $comp, 'owner' => $owner ?: null,
            'source' => $source ?: null, 'due_at' => $due, 'days_left' => $days === null ? null : round($days, 2), 'confidence' => $conf,
            'status' => $open ? 'open' : 'closed'], 'service' => ['name' => $svc], 'labels' => ['data_source' => 'detector']];
    }

    /** Least-squares slope (per second) and r^2 of t -> value. */
    public static function fit(array $series): array
    {
        $n = count($series); $xs = array_keys($series); $ys = array_values($series);
        $mx = array_sum($xs) / $n; $my = array_sum($ys) / $n;
        $sxy = $sxx = $syy = 0.0;
        foreach ($xs as $i => $x) { $sxy += ($x - $mx) * ($ys[$i] - $my); $sxx += ($x - $mx) ** 2; $syy += ($ys[$i] - $my) ** 2; }
        if ($sxx == 0 || $syy == 0) return [0.0, 0.0];
        return [$sxy / $sxx, $sxy * $sxy / ($sxx * $syy)];
    }

    /** Four wallboard slots + a summary row. Free slots show the next open risk (soonest first). */
    private static function rank(int $now, array $open, array $risks): array
    {
        $ps = array_values($open);
        usort($ps, fn($a, $b) => [$a['problem']['severity_rank'], -$a['impact']['value_at_risk']] <=> [$b['problem']['severity_rank'], -$b['impact']['value_at_risk']]);
        $rs = array_values(array_filter($risks, fn($r) => $r['risk']['status'] === 'open'));
        usort($rs, fn($a, $b) => $a['risk']['days_left'] <=> $b['risk']['days_left']);
        $docs = [];
        for ($slot = 1; $slot <= 4; $slot++) {
            $base = ['@timestamp' => self::iso($now), 'slot' => $slot, 'labels' => ['data_source' => 'detector']];
            if ($p = $ps[$slot - 1] ?? null) $docs[] = ["slot-$slot", $base + ['kind' => 'problem'] + array_diff_key($p, ['@timestamp' => 1, 'labels' => 1])];
            elseif ($r = array_shift($rs)) $docs[] = ["slot-$slot", $base + ['kind' => 'risk'] + array_diff_key($r, ['@timestamp' => 1, 'labels' => 1])];
            else $docs[] = ["slot-$slot", $base + ['kind' => 'none']];
        }
        $over = array_slice($ps, 4);
        $count = fn($list, $s) => count(array_filter($list, fn($p) => $p['problem']['severity'] === $s));
        $docs[] = ['summary', ['@timestamp' => self::iso($now), 'slot' => 0, 'kind' => 'summary', 'labels' => ['data_source' => 'detector'], 'summary' => [
            'open' => count($ps), 'critical' => $count($ps, 'critical'), 'major' => $count($ps, 'major'), 'minor' => $count($ps, 'minor'),
            'overflow' => count($over), 'overflow_critical' => $count($over, 'critical'), 'overflow_major' => $count($over, 'major'),
            'overflow_minor' => $count($over, 'minor'), 'risks' => count(array_filter($risks, fn($r) => $r['risk']['status'] === 'open'))]]];
        return $docs;
    }
}
