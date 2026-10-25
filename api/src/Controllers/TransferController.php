<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Banks, Rewards, Ledger, Attempts};

class TransferController
{
    private static function shapeTx(array $t): array
    {
        return [
            '_id' => $t['id'], 'id' => $t['id'],
            'fromAccount' => $t['fromAccountId'], 'toAccount' => $t['toAccountId'],
            'amount' => (float) $t['amount'], 'status' => $t['status'],
            'idempotencyKey' => $t['idempotencyKey'], 'description' => $t['description'],
            'category' => $t['category'], 'createdAt' => $t['createdAt'], 'updatedAt' => $t['updatedAt'] ?? null,
        ];
    }

    /** POST /api/transfer/quick — real ledger DEBIT, recipient is external (no CREDIT). */
    public function quick(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $bank = $b['bankName'] ?? null; $acc = $b['accountNumber'] ?? null; $conf = $b['confirmAccountNumber'] ?? null;
        $holder = $b['accountHolderName'] ?? null; $amount = $b['amount'] ?? null; $remarks = $b['remarks'] ?? null;
        $src = $b['sourceAccountId'] ?? null; $key = $b['idempotencyKey'] ?? null; $savePayee = !empty($b['savePayee']);

        $meta = ['amount' => $amount, 'category' => 'TRANSFER_EXTERNAL', 'sourceAccountId' => $src, 'idempotencyKey' => $key,
                 'target' => trim(($bank ?? '') . ' ' . Attempts::mask(is_string($acc) ? $acc : null))];
        return Attempts::run($req, $res, $u, 'EXTERNAL', $meta,
            fn() => $this->quickTransfer($u, $bank, $acc, $conf, $holder, $amount, $remarks, $src, $key, $savePayee));
    }

    /** @return array{0: array, 1: int, 2: ?string} [payload, HTTP status, transaction id] */
    private function quickTransfer(array $u, $bank, $acc, $conf, $holder, $amount, $remarks, $src, $key, bool $savePayee): array
    {
        if (!$bank || !$acc || !$conf || !$holder || !$amount || !$src || !$key) throw new ApiError('Missing required fields', 400);
        if (!in_array($bank, Banks::LIST, true)) throw new ApiError('Unknown bank', 400);
        if ($acc !== $conf) throw new ApiError('Account numbers do not match', 400);
        $amt = (float) $amount;
        if (!is_finite($amt) || $amt <= 0) throw new ApiError('Invalid amount', 400);
        if (!Attempts::isUuid($src)) throw new ApiError('Source account not found', 404);

        $srcAcc = Db::one('SELECT * FROM accounts WHERE id = :i AND user_id = :u LIMIT 1', [':i' => $src, ':u' => $u['id']]);
        if (!$srcAcc) throw new ApiError('Source account not found', 404);

        try {
            $tx = Ledger::debit($src, $amt, $key, "Transfer to $holder ($bank)", 'TRANSFER_EXTERNAL');
        } catch (ApiError $e) {
            if ($e->getMessage() === 'INSUFFICIENT_BALANCE')
                throw new ApiError('Insufficient balance', 400, ['available' => $e->extra['available'] ?? null]);
            throw $e;
        }

        if ($savePayee) {
            try {
                Db::run('INSERT INTO payees (user_id, bank_name, account_number, account_holder_name, nickname, active)
                    VALUES (:u,:b,:a,:h,:n,true) ON CONFLICT DO NOTHING',
                    [':u' => $u['id'], ':b' => $bank, ':a' => $acc, ':h' => trim($holder), ':n' => trim($holder)]);
            } catch (\Throwable $e) { /* ignore */ }
        }

        Rewards::award($u['id'], 'transfer.quick.first');
        if ($amt >= 500) Rewards::award($u['id'], 'transfer.amount.gte.500');
        if ($amt >= 5000) Rewards::award($u['id'], 'transfer.amount.gte.5000');
        if ($remarks) Rewards::award($u['id'], 'transfer.remarks');

        return [['message' => 'Transfer complete', 'transaction' => self::shapeTx($tx)], 201, $tx['id']];
    }

    public function createScheduled(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $payeeId = $b['payeeId'] ?? null; $src = $b['sourceAccountId'] ?? null;
        $amount = $b['amount'] ?? null; $nextRunAt = $b['nextRunAt'] ?? null;
        $remarks = $b['remarks'] ?? null; $freq = $b['frequency'] ?? 'ONCE';
        if (!$payeeId || !$src || !$amount || !$nextRunAt) throw new ApiError('payeeId, sourceAccountId, amount, nextRunAt required', 400);
        $row = Db::one(
            'INSERT INTO scheduled_transfers (user_id, payee_id, source_account_id, amount, remarks, frequency, next_run_at, enabled, status)
             VALUES (:u,:p,:s,:a,:r,:f,:n,true,\'SCHEDULED\') RETURNING *',
            [':u' => $u['id'], ':p' => $payeeId, ':s' => $src, ':a' => number_format((float) $amount, 2, '.', ''),
             ':r' => $remarks, ':f' => $freq, ':n' => $nextRunAt]
        );
        Rewards::award($u['id'], 'scheduled_transfer.created');
        return Http::json($res, ['scheduledTransfer' => Db::floats($row, ['amount'])], 201);
    }

    public function listScheduled(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all(
            'SELECT s.id, s.payee_id, p.nickname AS payee_name, p.bank_name, s.source_account_id,
                    s.amount, s.remarks, s.frequency, s.next_run_at, s.enabled, s.status, s.created_at
             FROM scheduled_transfers s JOIN payees p ON p.id = s.payee_id
             WHERE s.user_id = :u ORDER BY s.created_at DESC',
            [':u' => $u['id']]
        );
        return Http::json($res, ['scheduledTransfers' => array_map(fn($r) => Db::floats($r, ['amount']), $rows)]);
    }

    public function toggleScheduled(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $cur = Db::one('SELECT * FROM scheduled_transfers WHERE id=:i AND user_id=:u', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$cur) throw new ApiError('Not found', 404);
        $row = Db::one('UPDATE scheduled_transfers SET enabled = NOT enabled, updated_at=now() WHERE id=:i RETURNING *', [':i' => $args['id']]);
        return Http::json($res, ['scheduledTransfer' => Db::floats($row, ['amount'])]);
    }

    public function cancelScheduled(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $row = Db::one('UPDATE scheduled_transfers SET enabled=false, status=\'CANCELLED\', updated_at=now()
            WHERE id=:i AND user_id=:u RETURNING *', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$row) throw new ApiError('Not found', 404);
        Rewards::award($u['id'], 'scheduled_transfer.cancelled');
        return Http::json($res, ['scheduledTransfer' => Db::floats($row, ['amount'])]);
    }
}
