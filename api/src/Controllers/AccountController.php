<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError};

class AccountController
{
    /** balance = SUM(CREDIT) - SUM(DEBIT), per account id. */
    public static function balances(array $ids): array
    {
        if (!$ids) return [];
        $in = implode(',', array_fill(0, count($ids), '?'));
        $rows = Db::all(
            "SELECT account_id, COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS balance
             FROM ledger_entries WHERE account_id IN ($in) GROUP BY account_id",
            $ids
        );
        $map = [];
        foreach ($rows as $r) $map[$r['accountId']] = (float) $r['balance'];
        return $map;
    }

    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM accounts WHERE user_id = :u ORDER BY created_at', [':u' => $u['id']]);
        $bal = self::balances(array_column($rows, 'id'));
        $accounts = array_map(fn($a) => $a + ['balance' => $bal[$a['id']] ?? 0], $rows);
        return Http::json($res, ['accounts' => $accounts]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $a = Db::one('INSERT INTO accounts (user_id) VALUES (:u) RETURNING *', [':u' => $u['id']]);
        return Http::json($res, ['account' => $a + ['balance' => 0]], 201);
    }

    public function balance(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $acc = Db::one('SELECT id FROM accounts WHERE id = :a AND user_id = :u', [':a' => $args['id'], ':u' => $u['id']]);
        if (!$acc) throw new ApiError('Account not found', 404);
        $bal = self::balances([$args['id']]);
        return Http::json($res, ['accountId' => $args['id'], 'balance' => $bal[$args['id']] ?? 0]);
    }

    public function detail(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user'); $id = $args['id'];
        $a = Db::one('SELECT * FROM accounts WHERE id = :a AND user_id = :u', [':a' => $id, ':u' => $u['id']]);
        if (!$a) throw new ApiError('Account not found', 404);
        $bal = self::balances([$id]);
        $recent = Db::all(
            'SELECT * FROM transactions WHERE from_account_id = :a OR to_account_id = :a ORDER BY created_at DESC LIMIT 10',
            [':a' => $id]
        );
        $a['balance'] = $bal[$id] ?? 0;
        $a['maskedNumber'] = $a['accountNumber'] ? ('xxxx xx' . substr($a['accountNumber'], -4)) : null;
        $txs = array_map(fn($r) => [
            'id' => $r['id'], 'amount' => (float) $r['amount'], 'description' => $r['description'],
            'direction' => ($r['fromAccountId'] === $id && $r['toAccountId'] === $id) ? 'IN'
                : ($r['fromAccountId'] === $id ? 'OUT' : 'IN'),
            'status' => $r['status'], 'createdAt' => $r['createdAt'], 'category' => $r['category'],
        ], $recent);
        return Http::json($res, ['account' => $a, 'recentTransactions' => $txs]);
    }

    public function close(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user'); $id = $args['id'];
        $acc = Db::one('SELECT * FROM accounts WHERE id = :a AND user_id = :u', [':a' => $id, ':u' => $u['id']]);
        if (!$acc) throw new ApiError('Account not found', 404);
        if ($acc['isPrimary']) throw new ApiError('Primary account cannot be closed.', 400);
        if ($acc['status'] === 'CLOSED') throw new ApiError('Account already closed.', 400);
        $bal = self::balances([$id])[$id] ?? 0;
        if (abs($bal) > 0.005)
            throw new ApiError('Balance is ' . number_format($bal, 2, '.', '') . '. Move funds out before closing.', 400, ['balance' => $bal]);
        $up = Db::one("UPDATE accounts SET status='CLOSED', closed_at=now(), updated_at=now() WHERE id=:a RETURNING *", [':a' => $id]);
        return Http::json($res, ['account' => $up + ['balance' => $bal]]);
    }

    public function rename(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $name = ((array) $req->getParsedBody())['displayName'] ?? null;
        if (!$name || !is_string($name)) throw new ApiError('displayName is required', 400);
        $row = Db::one('UPDATE accounts SET display_name=:n, updated_at=now() WHERE id=:a AND user_id=:u RETURNING *',
            [':n' => trim($name), ':a' => $args['id'], ':u' => $u['id']]);
        if (!$row) throw new ApiError('Account not found', 404);
        return Http::json($res, ['account' => $row]);
    }

    public function ledger(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user'); $id = $args['id'];
        $acc = Db::one('SELECT id FROM accounts WHERE id = :a AND user_id = :u', [':a' => $id, ':u' => $u['id']]);
        if (!$acc) throw new ApiError('Account not found', 404);
        $entries = Db::all(
            'SELECT le.id, le.account_id, le.transaction_id, le.type, le.amount, le.created_at,
                    t.status AS transaction_status, t.from_account_id AS from_account, t.to_account_id AS to_account
             FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
             WHERE le.account_id = :a ORDER BY le.created_at',
            [':a' => $id]
        );
        $shaped = array_map(fn($e) => [
            '_id' => $e['id'], 'account' => $e['accountId'], 'type' => $e['type'], 'amount' => (float) $e['amount'],
            'transaction' => [
                '_id' => $e['transactionId'], 'status' => $e['transactionStatus'],
                'createdAt' => $e['createdAt'], 'fromAccount' => $e['fromAccount'], 'toAccount' => $e['toAccount'],
            ],
        ], $entries);
        return Http::json($res, ['accountId' => $id, 'entries' => $shaped]);
    }
}
