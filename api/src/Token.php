<?php
namespace Tensai;

/**
 * HS256 JWT, byte-compatible with the Node backend (jsonwebtoken):
 *   payload { userId, iat, exp }, 3-day expiry, same JWT_SECRET.
 * Hand-rolled to avoid a flagged dependency; HS256 is a signed
 * base64url(header).base64url(payload).HMAC-SHA256 triple.
 */
class Token
{
    private const TTL_DAYS = 3;

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

    public static function sign(string $userId): string
    {
        $now = time();
        $header = self::b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
        $payload = self::b64(json_encode(['userId' => $userId, 'iat' => $now, 'exp' => $now + self::TTL_DAYS * 86400]));
        $sig = self::b64(hash_hmac('sha256', "$header.$payload", self::secret(), true));
        return "$header.$payload.$sig";
    }

    /** Returns userId, or null if malformed / bad signature / expired. */
    public static function verify(string $jwt): ?string
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) return null;
        [$header, $payload, $sig] = $parts;

        $expected = self::b64(hash_hmac('sha256', "$header.$payload", self::secret(), true));
        if (!hash_equals($expected, $sig)) return null;

        $claims = json_decode(self::unb64($payload), true);
        if (!is_array($claims)) return null;
        if (isset($claims['exp']) && time() >= (int) $claims['exp']) return null;
        return $claims['userId'] ?? null;
    }

    public static function ttlSeconds(): int
    {
        return self::TTL_DAYS * 86400;
    }
}
