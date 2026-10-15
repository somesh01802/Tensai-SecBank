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
        $amt = (float) $amount;
        if (!is_finite($amt) || $amt <= 0) throw new ApiError('Invalid amount', 400);

        // Idempotency: a prior row with this key short-circuits.
        $dup = Db::one('SELECT * FROM transactions WHERE idempotency_key = :k', [':k' => $idempotencyKey]);
        if ($dup) return $dup;

        return Db::tx(function (PDO $pdo) use ($fromAccountId, $toAccountId, $amt, $idempotencyKey, $description, $category) {
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
}
