<?php
namespace Tensai;

/**
 * SecBank telemetry simulator (spec: Build Pack "Fault scenarios", Plan "Simulator realism").
 * Generates one minute at a time, deterministically from (seed, minute): the same minute always
 * yields the same documents and _ids, so re-running a window never duplicates data.
 *
 * Every document is labelled labels.data_source = "simulator" and labels.synthetic_user = true.
 * No scenario writes a fault label into the telemetry; ground truth goes to bank-demo-ledger only.
 *
 * minute() returns rows [sink, _id, ts (epoch s), doc]:
 *   business  -> logs-bank.business-default   journey steps, page views, ATM/teller, autopay runs, ATM heartbeats
 *   app       -> logs-bank.app-default        service logs (pattern field set at ingest) and deployments
 *   synth     -> logs-bank.synthetics-default synthetic monitor runs, every 5 minutes per location
 *   platform  -> metrics-bank.platform-default Kubernetes nodes/pods, JVM pool, retry queue, PostgreSQL
 *   ledger    -> bank-demo-ledger             ground truth (CAUSE line) at each scenario start
 *   apm       -> APM Server intake            microservice transactions/spans/errors (10 % sampled, sample_rate 0.1)
 */
final class Simulator
{
    /** Per hour at diurnal factor 1 (17:00), from D0 "Journey scorecard" (sums to 51,890 attempts). */
    public const JOURNEYS = [
        // name => [attempts/h, baseline completion, human time per step (median ms: reading, typing, OTP entry), channel weights]
        // Human time is tuned to the D0 "p95 to complete" column (login 6.2 s ... loan apply 9 m 40 s).
        'login' => [18420, 0.989, 3000, ['mobile_web' => .56, 'web' => .42, 'partner_api' => .02]],
        'view_accounts' => [15310, 0.996, 1000, ['mobile_web' => .44, 'web' => .32, 'atm' => .12, 'branch' => .08, 'partner_api' => .04]],
        'card_payment' => [6720, 0.982, 1600, ['mobile_web' => .48, 'web' => .44, 'partner_api' => .08]],
        'bill_pay' => [4960, 0.992, 1600, ['mobile_web' => .38, 'web' => .34, 'branch' => .18, 'partner_api' => .06, 'atm' => .04]],
        'p2p_transfer' => [3880, 0.971, 1800, ['mobile_web' => .40, 'web' => .28, 'branch' => .20, 'atm' => .06, 'partner_api' => .06]],
        'card_controls' => [1150, 0.991, 1900, ['mobile_web' => .60, 'web' => .40]],
        'autopay_setup' => [640, 0.950, 5500, ['mobile_web' => .45, 'web' => .55]],
        'onboarding' => [410, 0.904, 110000, ['mobile_web' => .40, 'web' => .30, 'branch' => .30]],
        'loan_apply' => [220, 0.860, 170000, ['mobile_web' => .30, 'web' => .30, 'branch' => .40]],
        'dispute' => [180, 0.978, 55000, ['mobile_web' => .45, 'web' => .30, 'branch' => .25]],
    ];

    /** Lost attempts by kind: reason, failure_class, status (abandoned = user left), dependency. */
    private const LOSSES = [
        'login' => [[.80, 'invalid_credentials', 'user', 'failed'], [.12, 'user_cancel', 'user', 'abandoned'], [.08, 'otp_expired', 'technical', 'failed', 'sms_otp']],
        'bill_pay' => [[.45, 'insufficient_funds', 'business', 'failed'], [.45, 'user_cancel', 'user', 'abandoned'], [.10, 'gateway_timeout', 'technical', 'failed', 'payment_gw']],
        'p2p_transfer' => [[.40, 'insufficient_funds', 'business', 'failed'], [.15, 'transfer_limit', 'business', 'failed'], [.37, 'user_cancel', 'user', 'abandoned'], [.08, 'otp_expired', 'technical', 'failed', 'sms_otp']],
        'card_payment' => [[.60, 'card_declined', 'business', 'failed'], [.25, 'fraud_hold', 'business', 'failed'], [.15, 'processor_timeout', 'technical', 'failed', 'card_processor']],
        '*' => [[.65, 'user_cancel', 'user', 'abandoned'], [.25, 'validation_error', 'user', 'failed'], [.10, 'service_error', 'technical', 'failed']],
    ];

    public const SERVICES = ['web-ui' => '7.4.1', 'api-gateway' => '3.2.0', 'auth-svc' => '2.3.0', 'accounts-svc' => '1.9.4',
        'transfers-svc' => '2.1.2', 'payments-svc' => '2.6.0', 'cards-svc' => '1.8.1', 'fraud-engine' => '4.0.3', 'notify-svc' => '1.5.2'];
    private const DEPS = ['payment_gw', 'sms_otp', 'card_processor'];
    private const NODES = 6;

    /** Scenario ground truth (Plan "Fault scenarios", Build Pack problem table). */
    public const SCENARIOS = [
        'S1' => ['P1', 'critical', 'payments-svc / payment_gw / latency', 'Bill payments stuck in pending'],
        'S2' => ['P5', 'major', 'auth-svc / connection pool / exhaustion', 'Login failures spike after a release'],
        'S3' => ['P3', 'major', 'auth-svc / sms_otp Northeast / provider degradation', 'OTP fails in one region only'],
        'S4' => ['P6', 'minor', 'web-ui / bundle / regression', 'Dashboard feels slow; backend is green'],
        'S5' => ['P7', 'major', 'cards-svc / fraud-engine / latency', 'Card payments declined wrongly'],
        'S6' => ['P8', 'major', 'transfers-svc / postgres transactions table / lock contention', 'Quick transfers slow and failing'],
        'S7' => ['P9', 'minor', 'payments-svc / payment_gw certificate / expiry', 'Gateway certificate expires in 7 days'],
        'S8' => ['P10', 'minor', 'notify-svc / memory / leak', 'Memory reaches the limit in about 6 hours'],
        'S9' => ['P2', 'major', 'transfers-svc / autopay job / silent skip', 'Autopay volume quietly drops'],
        'S10' => ['P4', 'minor', 'branch BR-017 / WAN link / link down', 'One branch stops transacting'],
    ];
    /** Demo runs: scenario => start, minutes before the freeze time (17:46). web-ui 7.4.2 ships at 17:11 in every run. */
    public const RUNS = ['none' => [], 's1' => ['S1' => 18], 'four' => ['S9' => 31, 'S1' => 18, 'S10' => 13, 'S3' => 9]];
    public const DEPLOY_MIN_BEFORE = 35;

    private const ATM_MONITORS = ['BR-003', 'BR-017', 'BR-022'];
    private const LOCATIONS = ['US East', 'US Central', 'US West'];
    private const BROWSER_MONITORS = ['login', 'bill_pay', 'p2p_transfer', 'onboarding', 'view_accounts', 'card_payment'];
    private const TABLES = ['transactions', 'accounts', 'ledger_entries', 'users'];

    private array $steps = [];      // journey => [step rows ordered]
    private array $branches = [];   // id => [region, lat, lon, atms]
    private array $customers = [];  // [ref, segment, region, branch]
    private array $timeline = [];   // [['id' => 'S1', 'start' => ts, 'end' => ?ts]]
    private array $deploys = [];    // [[ts, service, version]]
    private int $n = 0;
    private int $t0 = 0;

    public function __construct(private int $seed = 1, private float $scale = 1.0, int $customers = 20000)
    {
        foreach (Db::all('SELECT * FROM bank_journey_steps ORDER BY journey, step_index') as $s) $this->steps[$s['journey']][] = $s;
        foreach (Db::all('SELECT b.id, b.latitude, b.longitude, b.atm_count, r.name AS region FROM bank_branches b JOIN bank_regions r ON r.id = b.region_id') as $b)
            $this->branches[$b['id']] = [$b['region'], round((float) $b['latitude'], 4), round((float) $b['longitude'], 4), (int) $b['atmCount']];
        // Pseudonymous refs, unique and distinct from every real customer's ref.
        $taken = array_flip(array_map(fn($u) => BankExport::customerRef($u['id']), Db::all('SELECT id FROM users')));
        $ids = array_keys($this->branches);
        mt_srand($seed * 7919);
        for ($i = 0; count($this->customers) < $customers; $i++) {
            $ref = 'C-' . strtoupper(substr(md5("sim|$seed|$i"), 0, 6));
            if (isset($taken[$ref])) continue;
            $taken[$ref] = true;
            $p = mt_rand(0, 99);
            $br = $ids[mt_rand(0, count($ids) - 1)];
            $this->customers[] = [$ref, $p < 76 ? 'retail' : ($p < 91 ? 'premier' : 'sme'), $this->branches[$br][0], $br];
        }
    }

    public function customers(): array { return $this->customers; }

    /** Timeline of faults: [['id' => 'S1', 'start' => epoch, 'end' => epoch|null]], plus deployments. */
    public function setTimeline(array $timeline, array $deploys = []): void
    {
        $this->timeline = $timeline;
        $this->deploys = $deploys;
    }

    /** Minutes since scenario $id started at $t (fractional), or null when not active. */
    private function on(string $id, float $t): ?float
    {
        foreach ($this->timeline as $f)
            if ($f['id'] === $id && $t >= $f['start'] && ($f['end'] === null || $t < $f['end'])) return ($t - $f['start']) / 60;
        return null;
    }

    /** 0..1 ramp over the first $m minutes of a fault. */
    private function ramp(string $id, float $t, float $m = 3): float
    {
        $x = $this->on($id, $t);
        return $x === null ? 0.0 : min(1.0, $x / $m);
    }

    private function version(string $svc, float $t): string
    {
        $v = self::SERVICES[$svc];
        foreach ($this->deploys as [$ts, $s, $ver]) if ($s === $svc && $t >= $ts) $v = $ver;
        return $v;
    }

    // ---- randomness (mt_rand, seeded per minute) ----
    private static function r(): float { return mt_rand() / mt_getrandmax(); }
    private static function gauss(): float { return sqrt(-2 * log(max(1e-12, self::r()))) * cos(2 * M_PI * self::r()); }
    private static function logn(float $median, float $sigma): float { return $median * exp($sigma * self::gauss()); }
    private static function hex(int $n): string { $s = ''; while (strlen($s) < $n) $s .= sprintf('%08x', mt_rand()); return substr($s, 0, $n); }
    private static function poisson(float $l): int { return max(0, (int) round($l + sqrt($l) * self::gauss())); }
    private static function pick(array $weights): string
    {
        $x = self::r() * array_sum($weights);
        foreach ($weights as $k => $w) if (($x -= $w) <= 0) return (string) $k;
        return (string) array_key_last($weights);
    }
    private static function uuid(): string { $h = self::hex(32); return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-4' . substr($h, 13, 3) . '-a' . substr($h, 17, 3) . '-' . substr($h, 20); }

    /** Daily curve: quiet nights, morning and lunch peaks, payday (1st and 15th) spike. 1.0 at 17:00. */
    public static function diurnal(int $t): float
    {
        $h = (int) date('G', $t) + (int) date('i', $t) / 60;
        $curve = [0.12, 0.08, 0.06, 0.06, 0.08, 0.15, 0.35, 0.65, 0.95, 1.2, 1.15, 1.05, 1.15, 1.1, 1.0, 0.95, 0.95, 1.0, 1.0, 0.9, 0.75, 0.55, 0.35, 0.2];
        $a = $curve[(int) $h % 24]; $b = $curve[((int) $h + 1) % 24];
        $f = $a + ($b - $a) * ($h - floor($h));
        return in_array((int) date('j', $t), [1, 15], true) ? $f * 1.3 : $f;
    }

    private function row(string $sink, float $ts, array $doc): array
    {
        $doc['labels'] = ($doc['labels'] ?? []) + ['synthetic_user' => true, 'data_source' => 'simulator'];
        return [$sink, "sim{$this->seed}-{$this->t0}-" . ($this->n++), $ts, ['@timestamp' => self::iso($ts)] + $doc];
    }

    public static function iso(float $ts): string
    {
        return gmdate('Y-m-d\TH:i:s', (int) $ts) . sprintf('.%03dZ', (int) (fmod($ts, 1) * 1000));
    }

    /** All documents for the minute starting at $t0 (epoch seconds, minute-aligned). */
    public function minute(int $t0): array
    {
        $this->t0 = $t0;
        $this->n = 0;
        mt_srand(crc32("{$this->seed}|$t0"));
        $out = [];
        $f = self::diurnal($t0) * $this->scale;
        // Active pool rotates through the day: ~12k distinct customers in any hour.
        // Sliding active window (25 customers/minute) -> ~11.9k distinct customers in any hour, ~20k over a day.
        $pool = 11000;
        $off = (intdiv($t0, 60) * 25) % count($this->customers);

        foreach (self::JOURNEYS as $j => [$perHour]) {
            for ($i = self::poisson($perHour / 60 * $f); $i > 0; $i--) {
                $c = $this->customers[($off + mt_rand(0, $pool - 1)) % count($this->customers)];
                if ($j === 'bill_pay' && $c[1] !== 'sme' && self::r() < 0.25)   // SMEs pay more bills per session
                    for ($k = 0; $k < 3 && $c[1] !== 'sme'; $k++) $c = $this->customers[($off + mt_rand(0, $pool - 1)) % count($this->customers)];
                array_push($out, ...$this->journey($j, $c, $t0 + self::r() * 60));
            }
        }
        array_push($out, ...$this->inPerson($t0, $f), ...$this->autopay($t0), ...$this->deployments($t0),
            ...$this->platform($t0), ...$this->synthetics($t0), ...$this->ledger($t0));
        return $out;
    }

    /** Outcome for one attempt: [status, reason, class, dependency, failing step index] or completed. */
    private function outcome(string $j, array $c, string $ch, float $t): array
    {
        $last = count($this->steps[$j]);
        $digital = in_array($ch, ['web', 'mobile_web', 'partner_api'], true);
        // ---- faults (signals only; the cause is never written here) ----
        if ($j === 'bill_pay' && ($x = $this->ramp('S1', $t, 4)) > 0) {
            $r = self::r();
            if ($r < 0.34 * $x) return ['failed', 'gateway_timeout', 'technical', 'payment_gw', 4];
            if ($r < 0.48 * $x) return ['pending', 'gateway_timeout', 'technical', 'payment_gw', 4];
            if ($r < 0.64 * $x) return ['abandoned', 'user_cancel', 'user', null, 4];
        }
        if ($digital && $c[2] === 'Northeast' && in_array($j, ['login', 'p2p_transfer', 'onboarding'], true)
            && self::r() < 0.90 * $this->ramp('S3', $t, 2))   // codes expire before entry
            return ['failed', 'otp_expired', 'technical', 'sms_otp', $j === 'p2p_transfer' ? 3 : 1];
        if ($j === 'login' && self::r() < 0.25 * $this->ramp('S2', $t, 2)) return ['failed', 'auth_unavailable', 'technical', null, 1];
        if ($j === 'card_payment' && self::r() < 0.18 * $this->ramp('S5', $t, 3)) return ['failed', 'fraud_hold', 'business', null, 1];
        if ($j === 'p2p_transfer' && self::r() < 0.15 * $this->ramp('S6', $t, 3)) return ['failed', 'db_timeout', 'technical', null, 4];
        // ---- natural noise ----
        if (self::r() < self::JOURNEYS[$j][1]) return ['completed', null, null, null, $last];
        $l = self::LOSSES[$j] ?? self::LOSSES['*'];
        $k = self::pick(array_map(fn($x) => $x[0], $l));
        [, $reason, $class, $status] = $l[$k];
        $at = $status === 'abandoned' ? mt_rand(1, max(1, $last - 1)) : $last;
        if ($j === 'bill_pay' || $j === 'p2p_transfer') $at = $status === 'abandoned' ? mt_rand(1, 3) : 4;   // declines happen at confirm
        if ($reason === 'otp_expired') $at = $j === 'p2p_transfer' ? 3 : 1;
        return [$status, $reason, $class, $l[$k][4] ?? null, min($at, $last)];
    }

    /** One journey attempt: step events, page views, APM traces. */
    private function journey(string $j, array $c, float $t): array
    {
        $ch = self::pick(self::JOURNEYS[$j][3]);
        [$ref, $seg, $region, $home] = $c;
        if ($ch === 'branch' || $ch === 'atm') {
            $br = self::r() < 0.9 ? $home : array_rand($this->branches);
            if ($br === 'BR-017' && $this->on('S10', $t) !== null) return [];   // branch dark: walk-ins delayed, nothing emitted
        }
        [$status, $reason, $class, $dep, $failAt] = $this->outcome($j, $c, $ch, $t);
        $mobile = $ch === 'mobile_web';
        $ua = $mobile ? self::pick(['Safari' => 55, 'Chrome' => 45]) : self::pick(['Chrome' => 62, 'Edge' => 20, 'Safari' => 10, 'Firefox' => 8]);
        $jid = self::uuid();
        $out = [];
        $start = $t;
        // Bill amounts: D0 puts $412.8k on ~450 failed bills.
        $amount = match ($j) {
            'bill_pay' => round(self::logn(650, 0.75), 2), 'p2p_transfer' => round(self::logn(260, 0.9), 2),
            'card_payment' => round(self::logn(48, 0.9), 2), 'loan_apply' => round(self::logn(15000, 0.6), -2),
            'dispute' => round(self::logn(120, 0.8), 2), 'autopay_setup' => round(self::logn(180, 0.6), 2), default => null,
        };
        foreach ($this->steps[$j] as $s) {
            $i = (int) $s['stepIndex'];
            if ($i > $failAt) break;
            $final = $i === $failAt;
            $shown = $t;   // screen loads, then the customer reads / types / enters the OTP
            $t += self::logn(self::JOURNEYS[$j][2], 0.45) / 1000;
            if (isset($br) && $br === 'BR-017' && $this->on('S10', $t) !== null) break;   // link dropped mid-journey
            $svcs = array_map('trim', explode(',', $s['services']));
            [$ms, $apm] = $this->server($j, $s['step'], $svcs, $c, $ch, $t, $final ? $status : 'completed', $final ? $class : null, $final ? $dep : null);
            $st = $final ? ($status === 'completed' ? 'completed' : $status) : ($i === 1 ? 'started' : null);
            if ($final && $status === 'abandoned') $ms = null;
            $trace = $apm[0] ?? self::hex(32);
            $doc = [
                'event' => ['dataset' => 'bank.business', 'category' => 'journey', 'action' => $s['step'],
                    'outcome' => $final && $status !== 'completed' ? 'failure' : 'success', 'duration' => $ms === null ? null : (int) ($ms * 1e6)],
                'journey' => ['name' => $j, 'id' => $jid, 'step' => $s['step'], 'step_key' => "$j:{$s['step']}", 'step_index' => $i,
                    'status' => $st, 'reason_code' => $final ? $reason : null, 'failure_class' => $final ? $class : null,
                    'duration_ms' => $final ? (int) (($t - $start) * 1000 + ($ms ?? 0)) : null, 'step_duration_ms' => $ms === null ? null : (int) $ms],
                'bank' => ['txn' => ['amount' => $amount, 'currency' => $amount === null ? null : 'USD'], 'channel' => $ch, 'region' => $region,
                    'dependency' => $final ? $dep : null, 'customer' => ['ref' => $ref, 'segment' => $seg]]
                    + (isset($br) ? ['branch' => ['id' => $br, 'location' => ['lat' => $this->branches[$br][1], 'lon' => $this->branches[$br][2]]]] : [])
                    + ($ch === 'atm' ? ['atm' => ['id' => $br . '-ATM-' . mt_rand(1, $this->branches[$br][3])]] : []),
                'trace' => ['id' => $trace],
                'service' => ['name' => $svcs[0] === 'web-ui' && count($svcs) > 1 ? $svcs[1] : $svcs[0],
                    'version' => $this->version($svcs[0] === 'web-ui' && count($svcs) > 1 ? $svcs[1] : $svcs[0], $t), 'environment' => 'production'],
                'user_agent' => ['name' => $ch === 'partner_api' ? 'partner-agent' : ($ch === 'branch' || $ch === 'atm' ? null : $ua),
                    'device' => ['name' => $mobile ? 'mobile' : ($ch === 'web' ? 'desktop' : null)]],
                'http' => ['response' => ['status_code' => $final && $class === 'technical' ? ($reason === 'auth_unavailable' ? 503 : 504) : 200]],
            ];
            $out[] = $this->row('business', $t + ($ms ?? 0) / 1000, $doc);
            array_push($out, ...array_slice($apm, 1));
            if ($ch === 'web' || $ch === 'mobile_web') $out[] = $this->pageView($j, $s['step'], $c, $mobile, $ua, $jid, $trace, $shown);
            $t += ($ms ?? 500) / 1000;
        }
        return $out;
    }

    /** Core Web Vitals for one screen. S4 makes the front end slow after its release; the backend stays green. */
    private function pageView(string $j, string $step, array $c, bool $mobile, string $ua, string $jid, string $trace, float $t): array
    {
        $x = $this->ramp('S4', $t, 2);
        $lcp = self::logn($mobile ? 1700 : 1250, 0.35) * (1 + 1.4 * $x);
        $inp = self::logn(110, 0.45) * (1 + 2 * $x);
        $cls = self::r() < 0.06 ? round(0.1 + self::r() * 0.2, 3) : round(self::r() * 0.06, 3);
        return $this->row('business', $t, [
            'event' => ['dataset' => 'bank.business', 'category' => 'page_view', 'action' => 'page-load', 'duration' => (int) ($lcp * 1e6)],
            'journey' => ['name' => $j, 'id' => $jid, 'step' => $step, 'step_key' => "$j:$step"],
            'page' => ['route' => '/' . str_replace('_', '-', $j) . '/' . str_replace('_', '-', $step),
                'lcp_ms' => round($lcp), 'inp_ms' => round($inp), 'cls' => $cls, 'vitals_pass' => $lcp <= 2500 && $inp <= 200 && $cls <= 0.1],
            'bank' => ['channel' => $mobile ? 'mobile_web' : 'web', 'region' => $c[2], 'customer' => ['ref' => $c[0], 'segment' => $c[1]]],
            'trace' => ['id' => $trace],
            'service' => ['name' => 'web-ui', 'version' => $this->version('web-ui', $t), 'environment' => 'production'],
            'user_agent' => ['name' => $ua, 'device' => ['name' => $mobile ? 'mobile' : 'desktop']],
        ]);
    }

    /**
     * Server side of one step. Returns [duration ms, [trace id, ...apm rows]] (apm rows only for the 10 % sample).
     * Client-only steps (web-ui alone) have no trace.
     */
    private function server(string $j, string $step, array $svcs, array $c, string $ch, float $t, string $status, ?string $class, ?string $dep): array
    {
        $own = array_values(array_filter($svcs, fn($s) => $s !== 'web-ui' && !in_array($s, self::DEPS, true)));
        if (!$own) return [self::logn(250, 0.4), []];
        $svc = $own[0];
        $fail = $status !== 'completed' && $status !== 'abandoned';
        $spans = [];   // [name, type, subtype, resource|null, ms, outcome]
        $ms = self::logn(60, 0.4);
        $spans[] = ['SELECT FROM ' . ($svc === 'transfers-svc' ? 'transactions' : 'accounts'), 'db', 'postgresql', 'postgresql',
            $svc === 'transfers-svc' ? self::logn(4, 0.5) + 3500 * $this->ramp('S6', $t) * self::logn(1, 0.4) : self::logn(4, 0.5), 'success'];
        if (in_array('payment_gw', $svcs, true)) {
            $x = $this->ramp('S1', $t, 4);
            $tries = $fail ? 4 : ($x > 0 && self::r() < 0.35 * $x ? 2 : 1);
            for ($k = 1; $k <= $tries; $k++) {
                $timeout = $fail || $k < $tries;
                $d = $timeout ? 10000 : ($x > 0 ? min(9990, self::logn(5200, 0.4)) : self::logn(600, 0.35));
                $spans[] = ['POST payment_gw /v2/charges', 'external', 'http', 'payment_gw', $d, $timeout ? 'failure' : 'success'];
            }
        }
        if (in_array('sms_otp', $svcs, true) || ($j === 'login' && $step === 'sign_in') || ($j === 'onboarding' && $step === 'register')) {
            $slow = $c[2] === 'Northeast' && $this->on('S3', $t) !== null;
            // Send is asynchronous: the span (provider delivery) can outlast the auth-svc transaction.
            $spans[] = ['POST sms_otp /messages', 'external', 'http', 'sms_otp', $slow ? self::logn(9000, 0.3) : self::logn(700, 0.35),
                $dep === 'sms_otp' && $fail ? 'failure' : 'success', true];
        }
        if (in_array('card_processor', $svcs, true))
            $spans[] = ['POST card_processor /authorize', 'external', 'http', 'card_processor', $dep === 'card_processor' && $fail ? 8000 : self::logn(350, 0.35),
                $dep === 'card_processor' && $fail ? 'failure' : 'success'];
        if ($svc === 'auth-svc' && $this->on('S2', $t) !== null) $ms += $fail ? 5000 : self::logn(400, 0.5);   // waits on the exhausted pool
        foreach ($spans as $s) if (empty($s[6])) $ms += $s[4];
        $fraud = in_array('fraud-engine', $svcs, true) ? self::logn(80, 0.4) + 2400 * $this->ramp('S5', $t) * self::logn(1, 0.3) : 0;
        $ms += $fraud;
        if ($ch === 'partner_api') $ms += self::logn(40, 0.3);

        $trace = self::hex(32);
        if (self::r() >= 0.1) return [$ms, [$trace]];
        // ---- sampled trace: api-gateway -> owning service (-> fraud-engine) -> spans ----
        $route = ($step === 'load_accounts' ? 'GET' : 'POST') . ' /api/' . str_replace('_', '-', $j) . '/' . str_replace('_', '-', $step);
        $gw = self::hex(16); $tx = self::hex(16);
        $techFail = $fail && $class === 'technical';
        $res = $techFail ? 'HTTP 5xx' : ($fail ? 'HTTP 4xx' : 'HTTP 2xx');
        $out = [$trace];
        $out[] = $this->apm('api-gateway', $t, ['transaction' => self::tx($gw, $trace, null, $route, $t, $ms + 12, $res, 'request', 1)]);
        $out[] = $this->apm($svc, $t, ['transaction' => self::tx($tx, $trace, $gw, $route, $t + 0.005, $ms, $res, 'request', count($spans))]);
        $at = $t + 0.01;
        foreach ($spans as $s) {
            $out[] = $this->apm($svc, $at, ['span' => ['id' => self::hex(16), 'transaction_id' => $tx, 'parent_id' => $tx, 'trace_id' => $trace,
                'name' => $s[0], 'type' => $s[1], 'subtype' => $s[2], 'timestamp' => (int) ($at * 1e6), 'duration' => round($s[4], 3),
                'outcome' => $s[5], 'sample_rate' => 0.1,
                'context' => ['destination' => ['service' => ['resource' => $s[3], 'name' => $s[3], 'type' => $s[1]]],
                    'service' => ['target' => ['type' => $s[2], 'name' => $s[3]]]]]]);
            if (empty($s[6])) $at += $s[4] / 1000;
        }
        if ($fraud) {
            $fx = self::hex(16);
            $out[] = $this->apm('fraud-engine', $t + 0.02, ['transaction' => self::tx($fx, $trace, $tx, 'POST /score', $t + 0.02, $fraud, 'HTTP 2xx', 'request', 0)]);
        }
        if ($techFail) {
            $msg = match ($dep) { 'payment_gw' => 'payment_gw request timed out after 10000 ms (3 retries)', 'sms_otp' => 'OTP verification failed: code expired',
                'card_processor' => 'card_processor authorize timed out', default => $svc === 'auth-svc' ? 'Timeout acquiring connection from pool' : 'Upstream request failed' };
            $out[] = $this->apm($svc, $at, ['error' => ['id' => self::hex(32), 'trace_id' => $trace, 'transaction_id' => $tx, 'parent_id' => $tx,
                'timestamp' => (int) ($at * 1e6), 'culprit' => $route, 'exception' => ['message' => $msg,
                    'type' => match ($dep) { 'payment_gw' => 'GatewayTimeoutError', 'sms_otp' => 'OtpExpiredError', 'card_processor' => 'ProcessorTimeoutError',
                        default => $svc === 'auth-svc' ? 'PoolTimeoutError' : 'UpstreamError' }, 'handled' => true],
                'transaction' => ['sampled' => true, 'type' => 'request', 'name' => $route]]]);
            $out[] = $this->log($svc, $at, 'error', $msg, $trace);
        }
        return [$ms, $out];
    }

    private static function tx(string $id, string $trace, ?string $parent, string $name, float $t, float $ms, string $result, string $type, int $spans): array
    {
        return ['id' => $id, 'trace_id' => $trace, 'parent_id' => $parent, 'name' => $name, 'type' => $type, 'timestamp' => (int) ($t * 1e6),
            'duration' => round($ms, 3), 'result' => $result, 'outcome' => str_starts_with($result, 'HTTP 5') ? 'failure' : 'success',
            'sampled' => true, 'sample_rate' => 0.1, 'span_count' => ['started' => $spans, 'dropped' => 0]];
    }

    /** APM row: the intake event plus its service (the writer groups by service for the metadata line). */
    private function apm(string $svc, float $t, array $event): array
    {
        $pod = $svc . '-' . substr(md5($svc), 0, 6) . '-' . ['a1', 'b2', 'c3'][mt_rand(0, 2)];
        return ['apm', null, $t, ['service' => $svc, 'version' => $this->version($svc, $t), 'pod' => $pod,
            'node' => 'aks-secbank-' . (crc32($pod) % self::NODES), 'event' => $event]];
    }

    private function log(string $svc, float $t, string $level, string $msg, ?string $trace = null, ?string $pattern = null): array
    {
        return $this->row('app', $t, ['message' => $msg, 'log' => ['level' => $level], 'event' => ['dataset' => 'bank.app', 'category' => 'log'],
            'service' => ['name' => $svc, 'version' => $this->version($svc, $t), 'environment' => 'production'],
            'bank' => ['log_pattern' => $pattern ?? preg_replace('/\d+(\.\d+)?/', '<n>', $msg)], 'trace' => ['id' => $trace]]);
    }

    /** Teller and ATM transactions outside the ten journeys, plus ATM heartbeats every 5 minutes. */
    private function inPerson(int $t0, float $f): array
    {
        $out = [];
        foreach (['branch' => [3900, ['teller_deposit' => 55, 'teller_withdrawal' => 45]], 'atm' => [2300, ['atm_withdrawal' => 75, 'atm_balance' => 25]]] as $ch => [$h, $acts]) {
            for ($i = self::poisson($h / 60 * $f); $i > 0; $i--) {
                $c = $this->customers[mt_rand(0, count($this->customers) - 1)];
                $br = self::r() < 0.9 ? $c[3] : array_rand($this->branches);
                $t = $t0 + self::r() * 60;
                if ($br === 'BR-017' && $this->on('S10', $t) !== null) continue;
                $act = self::pick($acts);
                $out[] = $this->row('business', $t, ['event' => ['dataset' => 'bank.business', 'category' => 'transaction', 'action' => $act, 'outcome' => 'success'],
                    'bank' => ['txn' => ['amount' => $act === 'atm_balance' ? null : round(self::logn($ch === 'atm' ? 120 : 650, 0.7), -1), 'currency' => 'USD'],
                        'channel' => $ch, 'region' => $this->branches[$br][0], 'customer' => ['ref' => $c[0], 'segment' => $c[1]],
                        'branch' => ['id' => $br, 'location' => ['lat' => $this->branches[$br][1], 'lon' => $this->branches[$br][2]]]]
                        + ($ch === 'atm' ? ['atm' => ['id' => $br . '-ATM-' . mt_rand(1, $this->branches[$br][3])]] : []),
                    'service' => ['name' => $ch === 'atm' ? 'atm-switch' : 'teller-core']]);
            }
        }
        if (intdiv($t0, 60) % 5 === 0)
            foreach ($this->branches as $br => [$region, $lat, $lon, $atms])
                for ($a = 1; $a <= $atms; $a++) {
                    if ($br === 'BR-017' && $this->on('S10', $t0) !== null) continue;
                    $out[] = $this->row('business', $t0 + $a, ['event' => ['dataset' => 'bank.business', 'category' => 'heartbeat', 'action' => 'atm_heartbeat'],
                        'bank' => ['channel' => 'atm', 'region' => $region, 'branch' => ['id' => $br, 'location' => ['lat' => $lat, 'lon' => $lon]],
                            'atm' => ['id' => "$br-ATM-$a"]], 'service' => ['name' => 'atm-switch']]);
                }
        return $out;
    }

    /** Scheduled autopay runs (transfers-svc), 42 per minute. S9: the batch lock fails and runs are skipped silently. */
    private function autopay(int $t0): array
    {
        $out = [];
        $skip = $this->on('S9', $t0) !== null;
        $n = self::poisson($skip ? 15 : 42);
        for ($i = 0; $i < $n; $i++) {
            $c = $this->customers[mt_rand(0, count($this->customers) - 1)];
            $out[] = $this->row('business', $t0 + self::r() * 60, ['event' => ['dataset' => 'bank.business', 'category' => 'autopay_run', 'action' => 'autopay_run', 'outcome' => 'success'],
                'bank' => ['txn' => ['amount' => round(self::logn(300, 0.5), 2), 'currency' => 'USD'], 'region' => $c[2], 'customer' => ['ref' => $c[0], 'segment' => $c[1]]],
                'service' => ['name' => 'transfers-svc', 'version' => $this->version('transfers-svc', $t0)]]);
        }
        if ($skip) for ($i = 0; $i < 3; $i++)
            $out[] = $this->log('transfers-svc', $t0 + $i * 20, 'debug', 'autopay batch lock not acquired, skipping run batch=' . mt_rand(10000, 99999), null, 'autopay batch lock not acquired, skipping run batch=<n>');
        // Routine service logs, a few per service per minute.
        foreach (array_keys(self::SERVICES) as $svc)
            if ($svc !== 'web-ui') for ($i = mt_rand(1, 3); $i > 0; $i--)
                $out[] = $this->log($svc, $t0 + self::r() * 60, 'info', self::pick(['request completed in ' . mt_rand(5, 400) . ' ms' => 3, 'health check ok' => 1, 'cache refresh completed, ' . mt_rand(100, 900) . ' keys' => 1]));
        if (($x = $this->on('S1', $t0)) !== null && $x > 2)
            for ($i = 0; $i < 4; $i++) $out[] = $this->log('payments-svc', $t0 + $i * 15, 'warn', 'retry queue depth ' . (int) (min(1, $x / 14) * 1150) . ' exceeds threshold');
        if ($this->on('S3', $t0) !== null) $out[] = $this->log('notify-svc', $t0 + 5, 'warn', 'sms_otp delivery delayed region=us-northeast');
        if ($this->on('S6', $t0) !== null) $out[] = $this->log('transfers-svc', $t0 + 7, 'warn', 'lock wait timeout on table transactions after 5000 ms');
        return $out;
    }

    private function deployments(int $t0): array
    {
        $out = [];
        foreach ($this->deploys as [$ts, $svc, $ver])
            if ($ts >= $t0 && $ts < $t0 + 60)
                $out[] = $this->row('app', $ts, ['message' => "deployed $svc $ver", 'event' => ['dataset' => 'bank.app', 'category' => 'deployment', 'action' => 'deploy'],
                    'service' => ['name' => $svc, 'version' => $ver, 'environment' => 'production'], 'log' => ['level' => 'info'], 'bank' => ['log_pattern' => 'deployed <service> <version>']]);
        return $out;
    }

    /** Kubernetes nodes and pods, JVM gateway pool, retry queue, PostgreSQL; every 30 s. */
    private function platform(int $t0): array
    {
        $out = [];
        $k = ['orchestrator' => ['cluster' => ['name' => 'secbank-prod']]];
        foreach ([0, 30] as $dt) {
            $t = $t0 + $dt;
            $s1 = $this->ramp('S1', $t, 3); $s2 = $this->ramp('S2', $t, 2); $s6 = $this->ramp('S6', $t, 3);
            $load = self::diurnal($t0) * $this->scale;
            for ($n = 0; $n < self::NODES; $n++)
                $out[] = $this->row('platform', $t, $k + ['metricset' => ['name' => 'node'], 'host' => ['name' => "aks-secbank-$n"],
                    'kubernetes' => ['node' => ['name' => "aks-secbank-$n", 'ready' => true, 'cpu' => ['pct' => round(min(0.95, 0.30 + 0.2 * $load + 0.12 * $s1 + 0.03 * self::gauss()), 3)],
                        'memory' => ['pct' => round(0.55 + 0.03 * self::gauss(), 3)]]]]);
            foreach (array_keys(self::SERVICES) as $svc)
                foreach (['a1', 'b2', 'c3'] as $p) {
                    $pod = $svc . '-' . substr(md5($svc), 0, 6) . '-' . $p;
                    $mem = 0.45 + 0.03 * self::gauss();
                    if ($svc === 'notify-svc' && ($x = $this->on('S8', $t)) !== null) $mem = min(1.0, 0.55 + 0.45 * $x / 360);   // limit in ~6 h
                    $doc = $k + ['metricset' => ['name' => 'pod'], 'service' => ['name' => $svc],
                        'kubernetes' => ['namespace' => 'secbank', 'node' => ['name' => 'aks-secbank-' . (crc32($pod) % self::NODES)],
                            'pod' => ['name' => $pod, 'phase' => 'Running', 'restarts' => 0, 'cpu' => ['pct' => round(min(1, 0.2 + 0.25 * $load + ($svc === 'payments-svc' ? 0.5 * $s1 : 0) + 0.04 * self::gauss()), 3)],
                                'memory' => ['pct' => round($mem, 3), 'limit' => ['bytes' => 1073741824]]]]];
                    if ($svc === 'payments-svc') $doc['jvm'] = ['http_pool' => ['used' => (int) min(200, 30 + 25 * $load + 170 * $s1 + 4 * self::gauss()), 'max' => 200]];
                    if ($svc === 'auth-svc') $doc['jvm'] = ['db_pool' => ['used' => (int) min(50, 12 + 6 * $load + 38 * $s2), 'max' => 50]];
                    $out[] = $this->row('platform', $t, $doc);
                }
            $x = $this->on('S1', $t);
            $out[] = $this->row('platform', $t, $k + ['metricset' => ['name' => 'queue'], 'service' => ['name' => 'payments-svc'],
                'queue' => ['name' => 'payment-retries', 'depth' => (int) max(0, ($x === null ? 2 : 2 + 1150 * min(1, max(0, $x - 1.5) / 14)) + 2 * self::gauss())]]);
            $out[] = $this->row('platform', $t, $k + ['metricset' => ['name' => 'postgresql'], 'service' => ['name' => 'postgresql'],
                'postgresql' => ['connections' => (int) (60 + 30 * $load + 3 * self::gauss()), 'max_connections' => 200,
                    'lock_waits' => (int) max(0, 1 + 45 * $s6 + self::gauss()), 'slow_queries' => (int) max(0, 0.5 + 30 * $s6 + self::gauss())]]);
        }
        // Query time samples per table (box plot).
        foreach (self::TABLES as $tb)
            for ($i = 0; $i < 6; $i++)
                $out[] = $this->row('platform', $t0 + self::r() * 60, $k + ['metricset' => ['name' => 'postgresql_query'], 'service' => ['name' => 'postgresql'],
                    'postgresql' => ['table' => $tb, 'query' => ['time_ms' => round(self::logn(['transactions' => 4, 'accounts' => 2, 'ledger_entries' => 6, 'users' => 1.5][$tb], 0.6)
                        + ($tb === 'transactions' ? 600 * $this->ramp('S6', $t0) * self::logn(1, 0.5) : 0), 2)]]]);
        return $out;
    }

    /** Synthetic monitors every 5 minutes: 6 browser x 3 locations, 3 ATM probes, partner API x 2, payment_gw TLS = 24 per run. */
    private function synthetics(int $t0): array
    {
        if (intdiv($t0, 60) % 5 !== 1) return [];
        $out = [];
        $run = function (string $id, string $name, string $type, string $loc, bool $up, array $extra = []) use (&$out, $t0) {
            $out[] = $this->row('synth', $t0 + mt_rand(0, 40), ['monitor' => ['id' => $id, 'name' => $name, 'type' => $type, 'status' => $up ? 'up' : 'down',
                'duration' => ['us' => (int) (self::logn($type === 'browser' ? 9e6 : 3e5, 0.2) * ($up ? 1 : 3))]], 'observer' => ['geo' => ['name' => $loc]],
                'summary' => ['up' => $up ? 1 : 0, 'down' => $up ? 0 : 1], 'event' => ['dataset' => 'bank.synthetics', 'category' => 'synthetics'],
                'error' => ['message' => $up ? null : ($extra['err'] ?? 'step failed')]] + array_diff_key($extra, ['err' => 1]));
        };
        foreach (self::BROWSER_MONITORS as $j)
            foreach (self::LOCATIONS as $loc) {
                $down = ($j === 'bill_pay' && ($this->on('S1', $t0) ?? -1) >= 2.5)
                    || ($loc === 'US East' && in_array($j, ['login', 'p2p_transfer', 'onboarding'], true) && ($this->on('S3', $t0) ?? -1) >= 0.5)
                    || ($j === 'login' && ($this->on('S2', $t0) ?? -1) >= 2);
                $run("journey-$j", 'Journey: ' . self::label($j), 'browser', $loc, !$down, ['journey' => ['name' => $j],
                    'err' => $j === 'bill_pay' ? 'Step 4 "Confirm payment": timeout waiting for receipt after 30000 ms' : 'Step "Verify OTP": code expired before entry']);
            }
        foreach (self::ATM_MONITORS as $br)
            $run("atm-$br", "ATM probe $br", 'http', 'US Central', !($br === 'BR-017' && $this->on('S10', $t0) !== null),
                ['bank' => ['branch' => ['id' => $br]], 'err' => 'connect ETIMEDOUT']);
        foreach (['US East', 'US West'] as $loc) $run('partner-api', 'Partner API health', 'http', $loc, true, ['bank' => ['channel' => 'partner_api']]);
        $days = $this->on('S7', $t0) !== null ? 7 - $this->on('S7', $t0) / 1440 : 212 - intdiv($t0, 86400) % 30;
        $run('tls-payment-gw', 'payment_gw TLS', 'http', 'US East', true, ['bank' => ['dependency' => 'payment_gw'],
            'tls' => ['server' => ['x509' => ['not_after' => self::iso($t0 + $days * 86400), 'subject' => ['common_name' => 'api.payment-gw.example']]]]]);
        return $out;
    }

    private static function label(string $j): string { return ucfirst(str_replace('_', ' ', $j)); }

    /** Ground truth, written when a scenario starts (never into telemetry). */
    private function ledger(int $t0): array
    {
        $out = [];
        foreach ($this->timeline as $f)
            if ($f['start'] >= $t0 && $f['start'] < $t0 + 60) $out[] = ['ledger', $f['id'] . '-' . $f['start'], $f['start'], self::ledgerDoc($f)];
        return $out;
    }

    public static function ledgerDoc(array $f): array
    {
        [$p, $sev, $cause, $symptom] = self::SCENARIOS[$f['id']];
        [$svc, $comp, $type] = array_map('trim', explode('/', $cause));
        return ['@timestamp' => self::iso($f['start']), 'scenario' => ['id' => $f['id'], 'symptom' => $symptom],
            'problem' => ['id' => $p, 'severity' => $sev], 'cause' => ['line' => "CAUSE: $cause", 'service' => $svc, 'component' => $comp, 'type' => $type],
            'started_at' => self::iso($f['start']), 'ended_at' => $f['end'] ? self::iso($f['end']) : null, 'labels' => ['data_source' => 'simulator']];
    }
}
