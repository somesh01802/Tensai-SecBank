<?php
namespace Tensai;

/**
 * Thin wrapper over the Elastic APM PHP agent (extension `elastic_apm`).
 * Every call is a safe no-op when the agent isn't loaded (local dev, or CLI
 * with APM disabled), so callers never need to guard. Its job is to attribute
 * the current HTTP transaction to a user — so Kibana APM shows user.name /
 * user.id — and to attach searchable labels (labels.* in Discover).
 */
final class Apm
{
    private static function tx()
    {
        if (!class_exists(\Elastic\Apm\ElasticApm::class)) return null;
        try { return \Elastic\Apm\ElasticApm::getCurrentTransaction(); }
        catch (\Throwable $e) { return null; }
    }

    /** Attribute the current transaction to a user (user.* fields in Kibana APM). */
    public static function setUser($id, ?string $username, ?string $email = null): void
    {
        $tx = self::tx();
        if ($tx) {
            try {
                $u = $tx->context()->user();
                if ($id !== null) $u->setId((string) $id);
                if ($username)    $u->setUsername($username);
                if ($email)       $u->setEmail($email);
            } catch (\Throwable $e) { /* method surface varies by agent version */ }
        }
        // Labels are the guaranteed-searchable fallback for the APM UI + Discover.
        if ($username)   self::label('username', $username);
        if ($id !== null) self::label('user_id', (string) $id);
    }

    public static function label(string $key, bool|int|float|string|null $value): void
    {
        $tx = self::tx();
        if (!$tx) return;
        try { $tx->setLabel($key, $value); } catch (\Throwable $e) {}
    }

    /**
     * Privacy-safe, stable user identifier for telemetry: keyed HMAC of the
     * user id (not reversible without the server secret). Same value in APM
     * labels and in the exported Kibana docs, so the two can be joined.
     */
    public static function userRef(?string $userId): ?string
    {
        if (!$userId) return null;
        $key = $_ENV['USER_REF_SALT'] ?? getenv('USER_REF_SALT') ?: ($_ENV['JWT_SECRET'] ?? getenv('JWT_SECRET') ?: 'tensai');
        return 'u_' . substr(hash_hmac('sha256', $userId, 'user-ref|' . $key), 0, 16);
    }

    /** Trace id of the current APM transaction (correlates DB rows with traces). */
    public static function traceId(): ?string
    {
        $tx = self::tx();
        if (!$tx) return null;
        try { return $tx->getTraceId(); } catch (\Throwable $e) { return null; }
    }

    /** Client session id from the X-Session-Id header (a random UUID the browser/generator creates per login). */
    public static function sessionId(\Psr\Http\Message\ServerRequestInterface $req): ?string
    {
        $s = strtolower(trim($req->getHeaderLine('X-Session-Id')));
        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $s) ? $s : null;
    }

    /** Correlation labels attached to every authenticated request. */
    public static function correlate(\Psr\Http\Message\ServerRequestInterface $req, array $user): void
    {
        self::label('user_ref', self::userRef($user['id'] ?? null));
        self::label('synthetic', (bool) ($user['isSynthetic'] ?? false));
        if ($sid = self::sessionId($req)) self::label('session_id', $sid);
    }

    /** Rename the current transaction (e.g. "POST /api/auth/login"). */
    public static function name(string $name): void
    {
        $tx = self::tx();
        if (!$tx) return;
        try { $tx->setName($name); } catch (\Throwable $e) {}
    }

    /**
     * Business failure (4xx ApiError): mark the transaction outcome "failure"
     * (Kibana's failed-transaction rate only counts 5xx by default), label the
     * reason, and record it under Errors so failures are grouped by message.
     */
    public static function failure(\Throwable $e): void
    {
        $tx = self::tx();
        if ($tx) {
            try { if (method_exists($tx, 'setOutcome')) $tx->setOutcome('failure'); } catch (\Throwable $x) {}
        }
        self::label('failure_reason', substr($e->getMessage(), 0, 200));
        self::error($e);
    }

    /** Report a server-side error to APM (shows under Errors in Kibana). */
    public static function error(\Throwable $e): void
    {
        if (!class_exists(\Elastic\Apm\ElasticApm::class)) return;
        try { \Elastic\Apm\ElasticApm::createErrorFromThrowable($e); } catch (\Throwable $x) {}
    }
}
