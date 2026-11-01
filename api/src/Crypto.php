<?php
namespace Tensai;

/**
 * Field encryption for sensitive data at rest (VAPT-06, VAPT-20): AES-256-GCM with a random nonce, key APP_DATA_KEY
 * (base64 of 32 random bytes) in api/.env, never in the database. Stored form: "enc:v1:" . base64(nonce|tag|ciphertext).
 * Values without the prefix are legacy plaintext (until bin/protect-data.php has run) and are returned unchanged.
 *
 * Generate a key once:  php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'
 * Losing the key makes encrypted card numbers and tax ids unrecoverable: back it up with the server secrets.
 */
final class Crypto
{
    private const PREFIX = 'enc:v1:';

    private static function key(): string
    {
        $k = base64_decode((string) ($_ENV['APP_DATA_KEY'] ?? getenv('APP_DATA_KEY') ?: ''), true);
        if ($k === false || strlen($k) !== 32) throw new \RuntimeException('APP_DATA_KEY must be base64 of 32 random bytes');
        return $k;
    }

    public static function encrypt(?string $plain): ?string
    {
        if ($plain === null || $plain === '' || self::isEncrypted($plain)) return $plain;
        $nonce = random_bytes(12);
        $ct = openssl_encrypt($plain, 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, $nonce, $tag);
        if ($ct === false) throw new \RuntimeException('encryption failed');
        return self::PREFIX . base64_encode($nonce . $tag . $ct);
    }

    public static function decrypt(?string $value): ?string
    {
        if ($value === null || !self::isEncrypted($value)) return $value;
        $raw = base64_decode(substr($value, strlen(self::PREFIX)), true);
        if ($raw === false || strlen($raw) < 29) throw new \RuntimeException('corrupt encrypted value');
        $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
        if ($plain === false) throw new \RuntimeException('decryption failed (wrong APP_DATA_KEY?)');
        return $plain;
    }

    public static function isEncrypted(?string $v): bool
    {
        return is_string($v) && str_starts_with($v, self::PREFIX);
    }

    /**
     * Card verification value derived from PAN and expiry with a keyed hash, the way issuers compute CVVs (from a
     * card verification key) instead of storing them. Nothing is persisted (PCI DSS 3.3.2).
     */
    public static function cvv(string $pan, int $month, int $year): string
    {
        $h = hash_hmac('sha256', "cvv|$pan|" . sprintf('%02d%02d', $month, $year % 100), self::key(), true);
        return sprintf('%03d', (unpack('N', $h)[1] & 0x7fffffff) % 1000);
    }

    /** "ABCDE1234F" -> "XXXXX1234X" style mask for tax ids shown back to the customer. */
    public static function maskTaxId(?string $value): ?string
    {
        if ($value === null || $value === '') return $value;
        $v = self::decrypt($value);
        return str_repeat('X', max(0, strlen($v) - 4)) . substr($v, -4);
    }
}
