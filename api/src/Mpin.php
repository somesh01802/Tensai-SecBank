<?php
namespace Tensai;

/** MPIN set/verify with lockout — mirrors the Node mpin.service (bcrypt, 5 attempts, 15 min lock). */
class Mpin
{
    private const LOCK_AFTER = 5;
    private const LOCK_MINUTES = 15;

    public static function isValid($mpin): bool
    {
        return is_string($mpin) && preg_match('/^[0-9]{6}$/', $mpin) === 1;
    }

    public static function set(string $userId, $mpin): array
    {
        if (!self::isValid($mpin)) return ['ok' => false, 'message' => 'MPIN must be exactly 6 digits'];
        $hash = password_hash($mpin, PASSWORD_BCRYPT, ['cost' => 10]);
        $exists = Db::one('SELECT user_id FROM mpin_credentials WHERE user_id = :u', [':u' => $userId]);
        if ($exists) {
            Db::run('UPDATE mpin_credentials SET mpin_hash=:h, failed_attempts=0, locked_until=NULL, updated_at=now() WHERE user_id=:u',
                [':h' => $hash, ':u' => $userId]);
        } else {
            Db::run('INSERT INTO mpin_credentials (user_id, mpin_hash) VALUES (:u, :h)', [':u' => $userId, ':h' => $hash]);
        }
        return ['ok' => true];
    }

    public static function verify(string $userId, $mpin): array
    {
        if (!self::isValid($mpin)) return ['ok' => false, 'message' => 'Invalid MPIN format'];
        $row = Db::one('SELECT * FROM mpin_credentials WHERE user_id = :u', [':u' => $userId]);
        if (!$row) return ['ok' => false, 'message' => 'MPIN not set'];

        if (!empty($row['lockedUntil']) && strtotime($row['lockedUntil']) > time()) {
            return ['ok' => false, 'message' => 'Account locked. Try again after ' . $row['lockedUntil']];
        }

        if (!password_verify($mpin, $row['mpinHash'])) {
            $attempts = (int) $row['failedAttempts'] + 1;
            if ($attempts >= self::LOCK_AFTER) {
                $until = date('c', time() + self::LOCK_MINUTES * 60);
                Db::run('UPDATE mpin_credentials SET failed_attempts=0, locked_until=:t, updated_at=now() WHERE user_id=:u',
                    [':t' => $until, ':u' => $userId]);
            } else {
                Db::run('UPDATE mpin_credentials SET failed_attempts=:a, updated_at=now() WHERE user_id=:u',
                    [':a' => $attempts, ':u' => $userId]);
            }
            return ['ok' => false, 'message' => 'Incorrect MPIN', 'attemptsRemaining' => max(0, self::LOCK_AFTER - $attempts)];
        }

        Db::run('UPDATE mpin_credentials SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE user_id=:u', [':u' => $userId]);
        return ['ok' => true];
    }

    public static function has(string $userId): bool
    {
        return (bool) Db::one('SELECT user_id FROM mpin_credentials WHERE user_id = :u', [':u' => $userId]);
    }
}
