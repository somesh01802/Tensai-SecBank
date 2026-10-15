<?php
namespace Tensai;

use PDO;

/**
 * PDO singleton + helpers. Parses DATABASE_URL (postgres://user:pass@host:port/db).
 * camelize() maps snake_case columns -> camelCase to match the old Drizzle JSON.
 */
class Db
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo) return self::$pdo;
        $url = $_ENV['DATABASE_URL'] ?? getenv('DATABASE_URL') ?: '';
        if (!$url) throw new \RuntimeException('DATABASE_URL is not set');

        $p = parse_url($url);
        if ($p === false || !isset($p['host'])) throw new \RuntimeException('Invalid DATABASE_URL');
        $host = $p['host'];
        $port = $p['port'] ?? 5432;
        $db   = ltrim($p['path'] ?? '', '/');
        $user = isset($p['user']) ? rawurldecode($p['user']) : '';
        $pass = isset($p['pass']) ? rawurldecode($p['pass']) : '';

        $dsn = "pgsql:host=$host;port=$port;dbname=$db";
        self::$pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        return self::$pdo;
    }

    /** Run a query, return all rows (camelCased). */
    public static function all(string $sql, array $params = []): array
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return array_map([self::class, 'camelizeRow'], $st->fetchAll());
    }

    /** Run a query, return first row (camelCased) or null. */
    public static function one(string $sql, array $params = []): ?array
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row ? self::camelizeRow($row) : null;
    }

    /** Execute a statement, return affected row count. */
    public static function run(string $sql, array $params = []): int
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    /** Run a closure inside a transaction; rolls back on any throw. */
    public static function tx(callable $fn)
    {
        $pdo = self::pdo();
        $pdo->beginTransaction();
        try {
            $result = $fn($pdo);
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    public static function camelizeRow(array $row): array
    {
        $out = [];
        foreach ($row as $k => $v) $out[self::camel($k)] = $v;
        return $out;
    }

    public static function camel(string $s): string
    {
        return lcfirst(str_replace(' ', '', ucwords(str_replace('_', ' ', $s))));
    }

    /** Cast the given camelCase keys of a row to float (PG numerics come back as strings). */
    public static function floats(array $row, array $keys): array
    {
        foreach ($keys as $k) {
            if (array_key_exists($k, $row) && $row[$k] !== null) $row[$k] = (float) $row[$k];
        }
        return $row;
    }
}
