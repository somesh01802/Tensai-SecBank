<?php
namespace Tensai;

/**
 * HS256 JWT. Payload { userId, sid, sst, iat, iatMs, exp }:
 *   sid  session id (one per sign-in; logout revokes it, so renewed tokens die with it),
 *   sst  session start: a session can be renewed for at most MAX_SESSION seconds,
 *   exp  iat + IDLE: a token unused for 30 minutes expires (idle timeout, VAPT-09).
 * Auth renews the token on activity. Hand-rolled to avoid a flagged dependency; HS256 is a signed
 * base64url(header).base64url(payload).HMAC-SHA256 triple.
 */
class Token
{
    public const IDLE = 1800;          // 30 min idle timeout
    public const MAX_SESSION = 43200;  // 12 h absolute session lifetime
    public const RENEW_AFTER = 300;    // re-issue when the token is older than 5 min

    private static function secret(): string
    {
        $s = $_ENV['JWT_SECRET'] ?? getenv('JWT_SECRET') ?: '';
        if (!$s) throw new \RuntimeException('JWT_SECRET is not set');
        return $s;
    }

    private static function b64(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    private static function unb64(string $s): string
    {
        return base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4));
    }

    /** New session (sign-in) when $sid is null; otherwise a renewal inside the same session. */
    public static function sign(string $userId, ?string $sid = null, ?int $sst = null): string
    {
        $now = time();
        $header = self::b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
        $payload = self::b64(json_encode(['userId' => $userId, 'sid' => $sid ?? bin2hex(random_bytes(16)), 'sst' => $sst ?? $now,
            'iat' => $now, 'exp' => $now + self::IDLE, 'iatMs' => (int) floor(microtime(true) * 1000)]));
        $sig = self::b64(hash_hmac('sha256', "$header.$payload", self::secret(), true));
        return "$header.$payload.$sig";
    }

    /** Claims of a valid token, or null if malformed / bad signature / expired / older than the session model. */
    public static function claims(string $jwt): ?array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) return null;
        [$header, $payload, $sig] = $parts;

        $expected = self::b64(hash_hmac('sha256', "$header.$payload", self::secret(), true));
        if (!hash_equals($expected, $sig)) return null;

        $claims = json_decode(self::unb64($payload), true);
        if (!is_array($claims) || empty($claims['userId']) || empty($claims['sid']) || !isset($claims['exp'], $claims['sst'])) return null;
        if (time() >= (int) $claims['exp'] || time() - (int) $claims['sst'] >= self::MAX_SESSION) return null;
        return $claims;
    }

    /** Returns userId, or null if the token is not valid. */
    public static function verify(string $jwt): ?string
    {
        return self::claims($jwt)['userId'] ?? null;
    }

    /** Issue time in milliseconds of a token verify() has accepted. */
    public static function issuedAtMs(string $jwt): int
    {
        $claims = json_decode(self::unb64(explode('.', $jwt)[1] ?? ''), true);
        return (int) ($claims['iatMs'] ?? ((int) ($claims['iat'] ?? 0)) * 1000);
    }

    /** Cookie lifetime: the whole session (the token inside still expires after IDLE without activity). */
    public static function ttlSeconds(): int
    {
        return self::MAX_SESSION;
    }
}
