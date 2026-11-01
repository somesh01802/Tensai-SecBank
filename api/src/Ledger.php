<?php
namespace Tensai;

use PDO;

/**
 * Shared ACID debit — one DEBIT ledger entry inside a transaction, post-debit
 * balance checked non-negative (rolls back otherwise). Mirrors the Node
 * transfer.service debitAccount. `$toAccountId` optional: a distinct value
 * also credits the recipient (genuine internal transfer).
 */
class Ledger
{
    /** @return array the completed, camelized transaction row. Throws ApiError INSUFFICIENT_BALANCE. */
    public static function debit(string $fromAccountId, $amount, string $idempotencyKey, ?string $description, ?string $category, ?string $toAccountId = null): array
    {
        $amt = self::amount($amount);

        // Idempotency: a prior row with this key short-circuits, but only for the same source account
        // (keys are unique across all customers; never hand back someone else's transaction).
        $dup = Db::one('SELECT * FROM transactions WHERE idempotency_key = :k', [':k' => $idempotencyKey]);
        if ($dup) {
            if ($dup['fromAccountId'] !== $fromAccountId) throw new ApiError('Idempotency key already used', 409);
            return $dup;
        }

        return Db::tx(function (PDO $pdo) use ($fromAccountId, $toAccountId, $amt, $idempotencyKey, $description, $category) {
            self::lock($pdo, $fromAccountId);
            $a = number_format($amt, 2, '.', '');
            $to = $toAccountId ?: $fromAccountId;
            $st = $pdo->prepare("INSERT INTO transactions (from_account_id,to_account_id,amount,status,idempotency_key,description,category)
                VALUES (?,?,?,'COMPLETED',?,?,?) RETURNING *");
            $st->execute([$fromAccountId, $to, $a, $idempotencyKey, $description, $category]);
            $tx = $st->fetch();
            $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,'DEBIT',?)")
                ->execute([$fromAccountId, $tx['id'], $a]);
            $bst = $pdo->prepare("SELECT COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS bal FROM ledger_entries WHERE account_id = ?");
            $bst->execute([$fromAccountId]);
            $bal = (float) $bst->fetch()['bal'];
            if ($bal < 0) throw new ApiError('INSUFFICIENT_BALANCE', 400, ['available' => $bal + $amt]);
            if ($toAccountId && $toAccountId !== $fromAccountId) {
                $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,'CREDIT',?)")
                    ->execute([$toAccountId, $tx['id'], $a]);
            }
            return Db::camelizeRow($tx);
        });
    }

    /**
     * Serialise every debit of one account: the balance check below reads the ledger, which under READ COMMITTED
     * cannot see a concurrent, uncommitted debit. Holding the account row lock until commit makes the read-check-write
     * atomic (VAPT-01). Credits do not take the lock, so A->B and B->A transfers cannot deadlock.
     */
    public static function lock(PDO $pdo, string $accountId): void
    {
        $st = $pdo->prepare('SELECT id FROM accounts WHERE id = ? FOR UPDATE');
        $st->execute([$accountId]);
        if (!$st->fetch()) throw new ApiError('Source account not found', 404);
    }

    /** True when the account exists, is ACTIVE and belongs to the user (VAPT-03: never debit an account the requester does not own). */
    public static function ownedActive($accountId, ?string $userId): bool
    {
        if (!is_string($accountId) || !Attempts::isUuid($accountId) || !$userId) return false;
        return (bool) Db::one("SELECT 1 FROM accounts WHERE id = :a AND user_id = :u AND status = 'ACTIVE'", [':a' => $accountId, ':u' => $userId]);
    }

    /** Positive amount of at least one cent, after rounding to cents (0.001 used to pass and post 0.00: VAPT-18). */
    public static function amount($amount): float
    {
        $amt = is_numeric($amount) ? round((float) $amount, 2) : NAN;
        if (!is_finite($amt) || $amt < 0.01) throw new ApiError('Invalid amount', 400);
        return $amt;
    }
}
