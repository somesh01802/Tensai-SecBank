<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError};
use PDO;

class BillController
{
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM bills WHERE user_id = :u ORDER BY due_date ASC', [':u' => $u['id']]);
        return Http::json($res, ['bills' => $rows]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $biller = $b['billerName'] ?? null; $cat = $b['category'] ?? null; $amount = $b['amount'] ?? null;
        if (!$biller || !$cat || $amount === null) throw new ApiError('billerName, category and amount are required', 400);
        $row = Db::one(
            'INSERT INTO bills (user_id, biller_name, category, amount, due_date, icon_hint, status)
             VALUES (:u,:b,:c,:a,:d,:i,\'DUE\') RETURNING *',
            [':u' => $u['id'], ':b' => $biller, ':c' => $cat, ':a' => number_format((float) $amount, 2, '.', ''),
             ':d' => !empty($b['dueDate']) ? $b['dueDate'] : null, ':i' => $b['iconHint'] ?? null]
        );
        return Http::json($res, ['bill' => $row], 201);
    }

    public function pay(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $from = ((array) $req->getParsedBody())['fromAccountId'] ?? null;
        $bill = Db::one('SELECT * FROM bills WHERE id = :i AND user_id = :u', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$bill) throw new ApiError('Bill not found', 404);
        if ($bill['status'] === 'PAID') return Http::json($res, ['message' => 'Bill already paid', 'bill' => $bill]);

        $paidTxId = null;
        if ($from) {
            $paidTxId = Db::tx(function (PDO $pdo) use ($from, $bill) {
                $key = 'bill-' . $bill['id'] . '-' . (int) (microtime(true) * 1000);
                $st = $pdo->prepare("INSERT INTO transactions (from_account_id,to_account_id,amount,status,idempotency_key,description,category)
                    VALUES (?,?,?,'COMPLETED',?,?,?) RETURNING id");
                $st->execute([$from, $from, $bill['amount'], $key, 'Bill payment · ' . $bill['billerName'], $bill['category']]);
                $tx = $st->fetch();
                $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,'DEBIT',?)")
                    ->execute([$from, $tx['id'], $bill['amount']]);
                return $tx['id'];
            });
        }
        $row = Db::one('UPDATE bills SET status=\'PAID\', paid_at=now(), paid_tx_id=:t WHERE id=:i RETURNING *',
            [':t' => $paidTxId, ':i' => $bill['id']]);
        return Http::json($res, ['message' => 'Bill paid', 'bill' => $row]);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM bills WHERE id = :i AND user_id = :u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('Bill not found', 404);
        return Http::json($res, ['message' => 'Bill removed']);
    }
}
