<?php
/**
 * SecBank simulator: simulated bank telemetry for the D0-D9 dashboards and the Canvas wallboard.
 * Writes only to logs-bank.* / metrics-bank.* / bank-* (ES_BANK_API_KEY) and, when APM_SERVER_URL is set,
 * simulated microservice traces to the APM Server intake. Never touches Postgres data or tensai-* indices.
 * Run bin/setup-elastic.php once first.
 *
 *   php bin/simulate.php --backfill=60 --run=s1        the hour ending now, S1 from 18 min before the end (17:28 of 17:46)
 *   php bin/simulate.php --backfill=60 --run=four      S9, S1, S10, S3 at the spec offsets
 *   php bin/simulate.php --backfill=60 --run=S6        any single scenario, started 15 min before the end
 *   php bin/simulate.php --backfill=10080 --scale=0.1 --run=none   a week of quiet baseline for ML jobs
 *   php bin/simulate.php --live [--scale=0.1]          real time, minute by minute (systemd service)
 *   php bin/simulate.php --start=S3 | --stop=S3        presenter keys: start/stop a fault in the live run
 *   php bin/simulate.php --list                        active faults
 * Options: --seed=N (default 1) --no-apm --dry-run
 *
 * Deterministic per (seed, minute): re-running a window writes nothing new (op_type create, fixed _ids).
 * To replay a different scenario over a window that already has data, use another --seed.
 */
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use Tensai\{Es, Simulator, BankExport};

$o = getopt('', ['backfill:', 'live', 'run:', 'start:', 'stop:', 'list', 'scale:', 'seed:', 'no-apm', 'dry-run']);
$state = __DIR__ . '/../var/sim-faults.json';
$dry = isset($o['dry-run']);
$seed = (int) ($o['seed'] ?? 1);
$scale = (float) ($o['scale'] ?? 1.0);
if (!$dry && (!Es::env('ES_URL') || !Es::env('ES_BANK_API_KEY'))) { fwrite(STDERR, "ES_URL and ES_BANK_API_KEY must be set (api/.env)\n"); exit(1); }
$apmOn = !isset($o['no-apm']) && Es::env('APM_SERVER_URL');

const INDEX = ['business' => 'logs-bank.business-default', 'app' => 'logs-bank.app-default', 'synth' => 'logs-bank.synthetics-default',
    'platform' => 'metrics-bank.platform-default', 'ledger' => BankExport::LEDGER];

function loadFaults(string $f): array { return is_file($f) ? (json_decode((string) file_get_contents($f), true) ?: []) : []; }

/** Deployments that belong to a scenario (S2 auth-svc release, S4 web-ui release). */
function scenarioDeploys(array $timeline): array
{
    $d = [];
    foreach ($timeline as $f) {
        if ($f['id'] === 'S2') $d[] = [$f['start'], 'auth-svc', '2.3.1'];
        if ($f['id'] === 'S4') $d[] = [$f['start'], 'web-ui', '7.5.0'];
    }
    return $d;
}

// ---- presenter keys ----
if (isset($o['list'])) { echo json_encode(loadFaults($state), JSON_PRETTY_PRINT) . "\n"; exit(0); }
if (isset($o['start']) || isset($o['stop'])) {
    $id = strtoupper((string) ($o['start'] ?? $o['stop']));
    if (!isset(Simulator::SCENARIOS[$id])) { fwrite(STDERR, "unknown scenario $id (S1..S10)\n"); exit(1); }
    $faults = loadFaults($state);
    $open = array_filter($faults, fn($f) => $f['id'] === $id && $f['end'] === null);
    if (isset($o['start'])) {
        if ($open) { echo "$id already running\n"; exit(0); }
        $faults[] = $f = ['id' => $id, 'start' => time(), 'end' => null];
    } else {
        if (!$open) { echo "$id is not running\n"; exit(0); }
        $k = array_key_first($open);
        $faults[$k]['end'] = time();
        $f = $faults[$k];
    }
    @mkdir(dirname($state), 0750, true);
    file_put_contents($state, json_encode(array_values($faults)));
    // The live loop writes the ledger entry when it generates the start minute; a stop updates it here.
    if (isset($o['stop']) && !$dry) Es::bulk(BankExport::LEDGER, [[$f['id'] . '-' . $f['start'], Simulator::ledgerDoc($f)]], false, 'ES_BANK_API_KEY');
    echo (isset($o['start']) ? 'started ' : 'stopped ') . "$id\n";
    exit(0);
}

// ---- writer ----
$counts = [];
/** Send due rows. ES: bulk create per index. APM: one intake request per service (metadata line first). */
function send(array $rows, bool $dry, $apmOn, array &$counts): int
{
    $failed = 0;
    $by = [];
    foreach ($rows as [$sink, $id, $ts, $doc]) {
        $counts[$sink] = ($counts[$sink] ?? 0) + 1;
        if ($sink === 'apm') { if ($apmOn) $by['apm'][$doc['service'] . '|' . $doc['version'] . '|' . $doc['pod']][] = $doc; continue; }
        $by[$sink][] = [$id, $doc];
    }
    if ($dry) return 0;
    foreach ($by as $sink => $docs) {
        if ($sink === 'apm') continue;
        $failed += Es::bulk(INDEX[$sink], $docs, $sink !== 'ledger', 'ES_BANK_API_KEY');
    }
    foreach ($by['apm'] ?? [] as $docs) {
        $d = $docs[0];
        $meta = ['metadata' => ['service' => ['name' => $d['service'], 'version' => $d['version'], 'environment' => 'production',
            'agent' => ['name' => 'nodejs', 'version' => '4.7.0'], 'language' => ['name' => 'javascript'], 'runtime' => ['name' => 'node', 'version' => '20.11.1'],
            'node' => ['configured_name' => $d['pod']]],
            'system' => ['kubernetes' => ['namespace' => 'secbank', 'pod' => ['name' => $d['pod']], 'node' => ['name' => $d['node']]]],
            'labels' => ['synthetic_user' => true, 'data_source' => 'simulator']]];
        foreach (array_chunk($docs, 500) as $chunk) {
            $body = json_encode($meta) . "\n" . implode("\n", array_map(fn($x) => json_encode($x['event'], JSON_UNESCAPED_SLASHES), $chunk)) . "\n";
            $failed += apmSend($body) ? 0 : count($chunk);
        }
    }
    return $failed;
}

function apmSend(string $body): bool
{
    $h = ['Content-Type: application/x-ndjson'];
    if ($k = Es::env('APM_API_KEY')) $h[] = "Authorization: ApiKey $k";
    elseif ($k = Es::env('APM_SECRET_TOKEN')) $h[] = "Authorization: Bearer $k";
    $ch = curl_init(rtrim((string) Es::env('APM_SERVER_URL'), '/') . '/intake/v2/events');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $h, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 60]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code === 202) return true;
    static $warned = false;
    if (!$warned) { fwrite(STDERR, "  APM intake HTTP $code: " . substr((string) $raw, 0, 300) . "\n"); $warned = true; }
    return false;
}

$sim = new Simulator($seed, $scale);
if (!$dry) {
    $f = BankExport::simCustomers($sim->customers());
    echo '[sim] ' . count($sim->customers()) . ' simulated customers -> bank-customers' . ($f ? " ($f FAILED)" : '') . "\n";
}
echo '[sim] APM sink: ' . ($apmOn ? Es::env('APM_SERVER_URL') : 'off (APM_SERVER_URL not set or --no-apm)') . "\n";

// ---- backfill ----
if (isset($o['backfill'])) {
    $mins = max(1, (int) $o['backfill']);
    $end = intdiv(time(), 60) * 60;
    $run = (string) ($o['run'] ?? 'none');
    $offsets = Simulator::RUNS[strtolower($run)] ?? (isset(Simulator::SCENARIOS[strtoupper($run)]) ? [strtoupper($run) => 15] : null);
    if ($offsets === null) { fwrite(STDERR, "unknown --run=$run (none, s1, four, S1..S10)\n"); exit(1); }
    $timeline = [];
    foreach ($offsets as $id => $m) $timeline[] = ['id' => $id, 'start' => $end - $m * 60, 'end' => null];
    $sim->setTimeline($timeline, array_merge([[$end - Simulator::DEPLOY_MIN_BEFORE * 60, 'web-ui', '7.4.2']], scenarioDeploys($timeline)));
    if ($mins <= 180) {
        // Demo window: undo the time-of-day/payday curve so the frozen hour has the spec's 17:00 volume whenever it is run.
        for ($avg = 0, $t = $end - $mins * 60; $t < $end; $t += 60) $avg += Simulator::diurnal($t) / $mins;
        $sim = new Simulator($seed, $scale / $avg);
        $sim->setTimeline($timeline, array_merge([[$end - Simulator::DEPLOY_MIN_BEFORE * 60, 'web-ui', '7.4.2']], scenarioDeploys($timeline)));
        printf("[sim] demo window: time-of-day factor %.2f normalised to 1.00\n", $avg);
    }
    printf("[sim] backfill %d min ending %s (freeze time), run %s, scale %.2f, seed %d\n", $mins, date('H:i', $end), $run, $scale, $seed);
    $failed = 0;
    for ($t = $end - $mins * 60; $t < $end; $t += 60) {
        $rows = $sim->minute($t);
        // Rows past the freeze time (journeys still in progress) are dropped: they have not happened yet.
        $due = array_filter($rows, fn($r) => $r[2] < $end);
        $failed += send($due, $dry, $apmOn, $counts);
        if (($t - $end) % 600 === 0) printf("  %s %s\n", date('H:i', $t), json_encode($counts));
    }
    printf("[sim] done: %s%s\n", json_encode($counts), $failed ? " ($failed FAILED)" : '');
    exit($failed ? 1 : 0);
}

// ---- live ----
if (isset($o['live'])) {
    echo "[sim] live, scale $scale. Faults from var/sim-faults.json (--start/--stop).\n";
    $next = intdiv(time(), 60) * 60;
    $buffer = [];
    while (true) {
        if (time() >= $next) {
            $tl = loadFaults($state);
            $sim->setTimeline($tl, scenarioDeploys($tl));
            array_push($buffer, ...$sim->minute($next));
            $next += 60;
        }
        $now = microtime(true);
        $due = array_filter($buffer, fn($r) => $r[2] <= $now);
        $buffer = array_filter($buffer, fn($r) => $r[2] > $now);
        try {
            if ($due && ($f = send($due, $dry, $apmOn, $counts))) fwrite(STDERR, '[sim] ' . date('H:i:s') . " $f docs failed\n");
        } catch (Throwable $e) {
            fwrite(STDERR, '[sim] ' . date('H:i:s') . ' ' . $e->getMessage() . "\n");   // keep running; Elasticsearch may be briefly unavailable
        }
        if (intdiv((int) $now, 60) % 10 === 0 && (int) $now % 60 < 5) echo '[sim] ' . date('H:i') . ' ' . json_encode($counts) . "\n";
        sleep(5);
    }
}

fwrite(STDERR, "nothing to do: --backfill=N, --live, --start/--stop or --list (see header)\n");
exit(1);
