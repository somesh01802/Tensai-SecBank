<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Attempts};

/** Minimal disputes: raise one on a transaction that touched one of your accounts, and list yours. */
class DisputeController
{
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        return Http::json($res, ['disputes' => Db::all(
            'SELECT id, transaction_id, reason, status, created_at FROM disputes WHERE user_id = :u ORDER BY created_at DESC LIMIT 100',
            [':u' => $u['id']])]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $txId = $b['transactionId'] ?? null;
        $reason = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) ($b['reason'] ?? '')));
        if (!Attempts::isUuid($txId)) throw new ApiError('transactionId is required', 400);
        if (mb_strlen($reason) < 3 || mb_strlen($reason) > 300) throw new ApiError('reason must be 3 to 300 characters', 400);

        $owned = Db::one(
            'SELECT t.id FROM transactions t JOIN accounts a ON a.id IN (t.from_account_id, t.to_account_id)
             WHERE t.id = :t AND a.user_id = :u LIMIT 1', [':t' => $txId, ':u' => $u['id']]);
        if (!$owned) throw new ApiError('Transaction not found', 404);

        $row = Db::one(
            'INSERT INTO disputes (user_id, transaction_id, reason) VALUES (:u,:t,:r)
             ON CONFLICT (transaction_id) WHERE status = \'OPEN\' DO NOTHING
             RETURNING id, transaction_id, reason, status, created_at',
            [':u' => $u['id'], ':t' => $txId, ':r' => $reason]);
        if (!$row) throw new ApiError('An open dispute already exists for this transaction', 409);
        return Http::json($res, ['dispute' => $row], 201);
    }
}
