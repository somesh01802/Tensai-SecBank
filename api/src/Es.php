<?php
namespace Tensai;

/**
 * Minimal Elasticsearch client for the CLI jobs (exporter, setup, health).
 * ES_URL + an API key from api/.env: ES_API_KEY (tensai-* indices) or
 * ES_BANK_API_KEY (logs-bank.* / bank-*). ES_INSECURE=1 skips TLS checks.
 */
final class Es
{
    public static function env(string $k): ?string
    {
        $v = $_ENV[$k] ?? getenv($k);
        return ($v === false || $v === '') ? null : (string) $v;
    }

    /** One request. Returns [status, decoded JSON]. Throws only if ES is unreachable. */
    public static function req(string $method, string $path, $body = '', string $keyVar = 'ES_API_KEY',
                               string $ctype = 'application/json'): array
    {
        $h = ['Content-Type: ' . $ctype];
        if ($k = self::env($keyVar)) $h[] = 'Authorization: ApiKey ' . $k;
        $ch = curl_init(rtrim((string) self::env('ES_URL'), '/') . $path);
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 120]);
        if (!self::env($keyVar) && self::env('ES_USER')) curl_setopt($ch, CURLOPT_USERPWD, self::env('ES_USER') . ':' . self::env('ES_PASS'));
        if (self::env('ES_INSECURE')) { curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0); }
        if (is_array($body)) $body = json_encode($body, JSON_UNESCAPED_SLASHES);
        if ($body !== '') curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $raw = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($raw === false) throw new \RuntimeException("Elasticsearch unreachable: $err");
        return [$code, json_decode($raw, true) ?: []];
    }

    /** Request that must succeed. */
    public static function ok(string $method, string $path, $body = '', string $keyVar = 'ES_BANK_API_KEY'): array
    {
        [$code, $j] = self::req($method, $path, $body, $keyVar);
        if ($code >= 300) throw new \RuntimeException("$method $path HTTP $code: " . json_encode($j['error'] ?? $j));
        return $j;
    }

    /** ES|QL query -> list of associative rows. */
    public static function esql(string $query, string $keyVar = 'ES_BANK_API_KEY'): array
    {
        $j = self::ok('POST', '/_query?format=json', ['query' => $query], $keyVar);
        $cols = array_column($j['columns'] ?? [], 'name');
        return array_map(fn($v) => array_combine($cols, $v), $j['values'] ?? []);
    }

    /**
     * Bulk write. $docs = [[_id, doc], ...]. $create=true for data streams (op "create"):
     * an already-present _id is a no-op, which makes re-runs idempotent. Returns #failed.
     */
    public static function bulk(string $index, array $docs, bool $create, string $keyVar): int
    {
        $failed = 0;
        foreach (array_chunk($docs, 1000) as $chunk) {
            $buf = '';
            foreach ($chunk as [$id, $doc])
                $buf .= json_encode([$create ? 'create' : 'index' => ['_index' => $index, '_id' => (string) $id]]) . "\n"
                      . json_encode($doc, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES) . "\n";
            [$code, $j] = self::req('POST', '/_bulk', $buf, $keyVar, 'application/x-ndjson');
            if ($code >= 300) throw new \RuntimeException("bulk $index HTTP $code: " . json_encode($j['error'] ?? $j));
            foreach ($j['errors'] ?? false ? $j['items'] : [] as $it) {
                $err = reset($it)['error'] ?? null;
                if (!$err || ($create && $err['type'] === 'version_conflict_engine_exception')) continue;
                if ($failed++ === 0) fwrite(STDERR, "  first error ($index): " . json_encode($err) . "\n");
            }
        }
        return $failed;
    }
}
