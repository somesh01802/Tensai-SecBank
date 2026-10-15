<?php
namespace Tensai;

/**
 * Runs the project's SQL migrations in order. These are the SAME idempotent
 * .sql files the Node backend used (IF NOT EXISTS / DO $$ guards), so pointing
 * this at an existing database adds nothing and drops nothing — old data is
 * preserved. Multi-statement files are sent to PostgreSQL in one go.
 */
class Migrations
{
    public static function run(string $dir): array
    {
        $applied = [];
        $files = glob(rtrim($dir, '/\\') . '/*.sql');
        sort($files);
        $pdo = Db::pdo();
        foreach ($files as $f) {
            $sql = file_get_contents($f);
            if (trim($sql) === '') continue;
            $pdo->exec($sql);
            $applied[] = basename($f);
        }
        return $applied;
    }
}
