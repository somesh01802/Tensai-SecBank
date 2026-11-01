<?php
namespace Tensai;

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for admin sign-in (VAPT-04). The secret is stored encrypted
 * (Crypto) in users.totp_secret; users.totp_last_step makes each code single-use.
 */
final class Totp
{
    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function newSecret(): string
    {
        $s = '';
        foreach (str_split(random_bytes(20)) as $c) $s .= self::B32[ord($c) & 31];
        return $s;
    }

    public static function uri(string $secret, string $account): string
    {
        return 'otpauth://totp/' . rawurlencode("Tensai SecBank:$account") . "?secret=$secret&issuer=Tensai%20SecBank&digits=6&period=30";
    }

    public static function code(string $secret, int $step): string
    {
        $bits = '';
        foreach (str_split($secret) as $c) $bits .= str_pad(decbin(strpos(self::B32, $c)), 5, '0', STR_PAD_LEFT);
        $key = '';
        foreach (str_split($bits, 8) as $b) if (strlen($b) === 8) $key .= chr(bindec($b));
        $h = hash_hmac('sha1', pack('J', $step), $key, true);
        $o = ord($h[19]) & 15;
        $n = (unpack('N', substr($h, $o, 4))[1] & 0x7fffffff) % 1000000;
        return str_pad((string) $n, 6, '0', STR_PAD_LEFT);
    }

    /** True when $otp matches the user's secret within ±1 step and that step was not used before; marks it used. */
    public static function verify(string $userId, ?string $otp): bool
    {
        if (!is_string($otp) || !preg_match('/^\d{6}$/', $otp)) return false;
        $row = Db::one('SELECT totp_secret, totp_last_step FROM users WHERE id = :u', [':u' => $userId]);
        if (!$row || !$row['totpSecret']) return false;
        $secret = Crypto::decrypt($row['totpSecret']);
        $now = intdiv(time(), 30);
        foreach ([$now - 1, $now, $now + 1] as $step) {
            if (!hash_equals(self::code($secret, $step), $otp)) continue;
            // Atomic: only one request can claim a step newer than the last one used.
            return (bool) Db::one('UPDATE users SET totp_last_step = :s WHERE id = :u AND (totp_last_step IS NULL OR totp_last_step < :s) RETURNING id',
                [':s' => $step, ':u' => $userId]);
        }
        return false;
    }
}
