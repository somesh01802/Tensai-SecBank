<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Attempts, Ledger};

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
        return Attempts::run($req, $res, $u, 'BILL', ['sourceAccountId' => $from],
            function (array &$meta) use ($u, $from, $args) {
                $bill = Attempts::isUuid($args['id'] ?? null)
                    ? Db::one('SELECT * FROM bills WHERE id = :i AND user_id = :u', [':i' => $args['id'], ':u' => $u['id']])
                    : null;
                if (!$bill) throw new ApiError('Bill not found', 404);
                $meta += ['amount' => $bill['amount'], 'category' => $bill['category'], 'target' => $bill['billerName']];
                if ($bill['status'] === 'PAID') return [['message' => 'Bill already paid', 'bill' => $bill], 200, $bill['paidTxId'] ?? null];

                $paidTxId = null;
                if ($from) {
                    // The source account must belong to the caller (previously unchecked).
                    $acc = Attempts::isUuid($from)
                        ? Db::one('SELECT id, status FROM accounts WHERE id = :a AND user_id = :u', [':a' => $from, ':u' => $u['id']])
                        : null;
                    if (!$acc) throw new ApiError('Source account not found', 404);
                    if ($acc['status'] !== 'ACTIVE') throw new ApiError('Source account is not active', 400);
                    // Ledger::debit = same COMPLETED tx + DEBIT entry as before, plus the
                    // non-negative balance check; a per-bill key stops double payment.
                    try {
                        $tx = Ledger::debit($from, $bill['amount'], 'bill-pay-' . $bill['id'],
                            'Bill payment · ' . $bill['billerName'], $bill['category']);
                    } catch (ApiError $e) {
                        if ($e->getMessage() === 'INSUFFICIENT_BALANCE')
                            throw new ApiError('Insufficient balance', 400, ['available' => $e->extra['available'] ?? null]);
                        throw $e;
                    }
                    $paidTxId = $tx['id'];
                }
                $row = Db::one('UPDATE bills SET status=\'PAID\', paid_at=now(), paid_tx_id=:t WHERE id=:i RETURNING *',
                    [':t' => $paidTxId, ':i' => $bill['id']]);
                return [['message' => 'Bill paid', 'bill' => $row], 200, $paidTxId];
            });
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM bills WHERE id = :i AND user_id = :u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('Bill not found', 404);
        return Http::json($res, ['message' => 'Bill removed']);
    }
}
