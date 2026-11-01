<?php
namespace Tensai;

/** Password policy and hashing (VAPT-11, ASVS V2.1): 12-72 characters, not a well-known password, bcrypt cost 12. */
final class Passwords
{
    public const MIN = 12;
    public const MAX_BYTES = 72;   // bcrypt ignores everything after 72 bytes
    private const COST = 12;

    /** The most common breached passwords of 12+ characters (case-insensitive); a full breach list needs an external service. */
    private const COMMON = ['123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiop123', 'password1234', 'password12345', 'passwordpassword',
        'iloveyou1234', 'administrator', 'welcome12345', 'letmein12345', '111111111111', '000000000000', '123123123123', 'abcdefghijkl',
        'abc123456789', 'qwerty123456', 'qazwsxedcrfv', '1q2w3e4r5t6y', 'zaq12wsxcde3', 'changeme1234', 'football1234', 'princess1234',
        'sunshine1234', 'tensaisecbank', 'secbank12345'];

    /** Returns an error message, or null when the password is acceptable. */
    public static function problem(?string $pw): ?string
    {
        if (!is_string($pw) || strlen($pw) < self::MIN) return 'Password must be at least ' . self::MIN . ' characters';
        if (strlen($pw) > self::MAX_BYTES) return 'Password must be at most ' . self::MAX_BYTES . ' characters';
        if (in_array(strtolower($pw), self::COMMON, true) || count(array_unique(str_split($pw))) < 4)
            return 'This password is too common. Choose a less predictable one';
        return null;
    }

    public static function hash(string $pw): string
    {
        return password_hash($pw, PASSWORD_BCRYPT, ['cost' => self::COST]);
    }

    public static function needsRehash(string $hash): bool
    {
        return password_needs_rehash($hash, PASSWORD_BCRYPT, ['cost' => self::COST]);
    }
}
