<?php
// Scheduler runner.
//   One tick (for cron / systemd timer):   php bin/scheduler.php
//   Long-running loop (every 60s):          php bin/scheduler.php --loop
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$loop = in_array('--loop', $argv, true);
if ($loop) {
    fwrite(STDERR, "[scheduler] loop mode, tick every 60s\n");
    while (true) {
        \Tensai\Scheduler::tick();
        sleep(60);
    }
}
\Tensai\Scheduler::tick();
fwrite(STDERR, "[scheduler] tick complete\n");
