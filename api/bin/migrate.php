<?php
// Run migrations: php bin/migrate.php
require __DIR__ . '/../vendor/autoload.php';
if (is_file(__DIR__ . '/../.env')) \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
$applied = \Tensai\Migrations::run(__DIR__ . '/../migrations');
foreach ($applied as $f) echo "[migrate] applied $f\n";
echo "[migrate] done (" . count($applied) . " files)\n";
