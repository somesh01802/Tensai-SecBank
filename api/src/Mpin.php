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

        // Reserve this attempt atomically before checking, so parallel guesses cannot exceed the limit: the counter
        // only moves while unlocked, and the request that reaches the limit sets the lock.
        $slot = Db::one("UPDATE mpin_credentials SET failed_attempts = failed_attempts + 1, updated_at = now()
            WHERE user_id = :u AND (locked_until IS NULL OR locked_until <= now()) AND failed_attempts < :max
            RETURNING failed_attempts", [':u' => $userId, ':max' => self::LOCK_AFTER]);
        if (!$slot) return ['ok' => false, 'message' => 'Account locked. Try again later'];

        if (!password_verify($mpin, $row['mpinHash'])) {
            $attempts = (int) $slot['failedAttempts'];
            if ($attempts >= self::LOCK_AFTER)
                Db::run("UPDATE mpin_credentials SET failed_attempts = 0, locked_until = now() + make_interval(mins => :m), updated_at = now()
                    WHERE user_id = :u", [':m' => self::LOCK_MINUTES, ':u' => $userId]);
            return ['ok' => false, 'message' => 'Incorrect MPIN', 'attemptsRemaining' => max(0, self::LOCK_AFTER - $attempts)];
        }

        Db::run('UPDATE mpin_credentials SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE user_id=:u', [':u' => $userId]);
        return ['ok' => true];
    }

    /**
     * Step-up for money movement and other sensitive actions (VAPT-05): the request body must carry the customer's
     * MPIN. Answers the SPA's shared MPIN prompt understands: 428 MPIN_REQUIRED, 403 MPIN_INVALID / MPIN_NOT_SET,
     * 429 MPIN_LOCKED. Wrong guesses count towards the same 5-try lockout as MPIN sign-in.
     */
    public static function stepUp(\Psr\Http\Message\ServerRequestInterface $req, array $user): void
    {
        $mpin = ((array) $req->getParsedBody())['mpin'] ?? null;
        if (!self::has($user['id'])) throw new ApiError('Set up your MPIN first', 403, ['code' => 'MPIN_NOT_SET']);
        if ($mpin === null || $mpin === '') throw new ApiError('Enter your MPIN to continue', 428, ['code' => 'MPIN_REQUIRED']);
        $v = self::verify($user['id'], $mpin);
        if ($v['ok']) return;
        if (str_starts_with($v['message'] ?? '', 'Account locked'))
            throw new ApiError('Too many incorrect MPIN attempts. Try again in 15 minutes.', 429, ['code' => 'MPIN_LOCKED']);
        throw new ApiError('Incorrect MPIN', 403, ['code' => 'MPIN_INVALID']);
    }

    public static function has(string $userId): bool
    {
        return (bool) Db::one('SELECT user_id FROM mpin_credentials WHERE user_id = :u', [':u' => $userId]);
    }
}
