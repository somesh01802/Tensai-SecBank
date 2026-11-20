<?php
/**
 * Alert drills: starts and stops SIMULATED fault scenarios on a fixed UTC schedule, so the alerting chain
 * (rule -> case -> workflow -> notification) is exercised at the target test frequencies:
 *   P3 (minor)    3 a day      S10 branch link down          02:00, 10:00, 18:00 UTC, 20 min
 *   P2 (major)    1 a week     S9 / S3 / S5 by ISO week      Wednesday 14:00 UTC, 25 min
 *   P1 (critical) 1 per 2 wks  S1 payment gateway latency    Tuesday 15:00 UTC on even ISO weeks, 25 min
 *
 * This only schedules simulated faults (labels.data_source = simulator). It never touches real detection:
 * a genuine problem alerts the minute the detector sees it, whatever this schedule says.
 * It only stops drills it started itself (var/drills.json), never a fault a presenter started by hand.
 *
 *   */5 * * * * root cd /var/www/tensai-secbank/api && php bin/incident-drill.php >> /var/log/tensai-drill.log 2>&1
 *   php bin/incident-drill.php --plan        next 14 days of drills, changes nothing
 *   php bin/incident-drill.php --selftest    checks the schedule arithmetic
 */

/** Drill due at time $t: [scenario, priority, window start, window end] or null. Pure, so it can be tested. */
function drillAt(int $t): ?array
{
    $day = intdiv($t, 86400) * 86400;
    $dow = (int) gmdate('N', $t);          // 1 = Monday
    $week = (int) gmdate('W', $t);
    $slots = [];
    foreach ([2, 10, 18] as $h) $slots[] = ['S10', 'P3', $day + $h * 3600, 20];
    if ($dow === 3) $slots[] = [['S9', 'S3', 'S5'][$week % 3], 'P2', $day + 14 * 3600, 25];
    if ($dow === 2 && $week % 2 === 0) $slots[] = ['S1', 'P1', $day + 15 * 3600, 25];
    foreach ($slots as [$s, $p, $from, $min])
        if ($t >= $from && $t < $from + $min * 60) return [$s, $p, $from, $from + $min * 60];
    return null;
}

$o = getopt('', ['plan', 'selftest']);

if (isset($o['selftest'])) {
    $check = function (bool $ok, string $what) { if (!$ok) { fwrite(STDERR, "selftest FAILED: $what\n"); exit(1); } };
    $mon = gmmktime(0, 0, 0, 11, 16, 2026);                       // Monday, ISO week 47 (odd)
    $count = ['P1' => 0, 'P2' => 0, 'P3' => 0];
    for ($t = $mon; $t < $mon + 28 * 86400; $t += 300) {          // four weeks, 5-minute ticks
        $d = drillAt($t);
        if ($d && $d[2] === $t) $count[$d[1]]++;
    }
    $check($count['P3'] === 84, 'P3: 3 a day for 28 days');
    $check($count['P2'] === 4, 'P2: 1 a week');
    $check($count['P1'] === 2, 'P1: 1 every two weeks');
    $check(drillAt(gmmktime(10, 19, 0, 11, 16, 2026))[0] === 'S10', 'inside a P3 window');
    $check(drillAt(gmmktime(10, 20, 0, 11, 16, 2026)) === null, 'window end is exclusive');
    echo "selftest ok: " . json_encode($count) . " in 28 days\n";
    exit(0);
}

if (isset($o['plan'])) {
    $now = time();
    for ($t = intdiv($now, 300) * 300; $t < $now + 14 * 86400; $t += 300) {
        $d = drillAt($t);
        if ($d && $d[2] === $t) printf("%s  %s  %s  %d min\n", gmdate('D Y-m-d H:i', $t) . ' UTC', $d[1], $d[0], ($d[3] - $d[2]) / 60);
    }
    exit(0);
}

$state = __DIR__ . '/../var/drills.json';
$mine = is_file($state) ? (json_decode((string) file_get_contents($state), true) ?: []) : [];
$sim = fn(string $arg) => trim((string) shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__DIR__ . '/simulate.php') . ' ' . $arg . ' 2>&1'));
$due = drillAt(time());
$stamp = gmdate('Y-m-d H:i');

// Stop drills this script started whose window has ended.
foreach ($mine as $s => $until)
    if (time() >= $until) { echo "$stamp stop $s: " . $sim("--stop=$s") . "\n"; unset($mine[$s]); }

// Start the due drill, unless that scenario is already running (by hand or by us).
if ($due && !isset($mine[$due[0]])) {
    $out = $sim("--start={$due[0]}");
    echo "$stamp {$due[1]} drill {$due[0]}: $out\n";
    if (str_starts_with($out, 'started')) $mine[$due[0]] = $due[3];
}

@mkdir(dirname($state), 0750, true);
file_put_contents($state, json_encode($mine));
