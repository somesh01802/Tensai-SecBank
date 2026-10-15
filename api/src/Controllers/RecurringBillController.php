<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, BillProvider, Rewards};

class RecurringBillController
{
    private static function shape(array $r): array { return Db::floats($r, ['amount']); }

    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM recurring_bills WHERE user_id = :u ORDER BY created_at DESC', [':u' => $u['id']]);
        return Http::json($res, ['recurringBills' => array_map([self::class, 'shape'], $rows)]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $biller = $b['billerName'] ?? null; $cat = $b['category'] ?? null; $nextRunAt = $b['nextRunAt'] ?? null;
        if (!$biller || !$cat || !$nextRunAt) throw new ApiError('billerName, category, nextRunAt required', 400);

        $autoDetect = !empty($b['autoDetectAmount']);
        $amount = $b['amount'] ?? null;
        if ($autoDetect) $amount = BillProvider::fetchAmount($biller, $cat)['amount'];
        if (!$amount) throw new ApiError('amount is required (or enable auto-detect)', 400);

        $autopay = array_key_exists('autopayEnabled', $b) ? (bool) $b['autopayEnabled'] : true;
        $row = Db::one(
            'INSERT INTO recurring_bills (user_id, biller_name, category, provider_hint, amount, auto_detect_amount, frequency, source_account_id, autopay_enabled, next_run_at, enabled)
             VALUES (:u,:b,:c,:ph,:a,:ad,:f,:sa,:ap,:n,true) RETURNING *',
            [':u' => $u['id'], ':b' => $biller, ':c' => $cat, ':ph' => $b['providerHint'] ?? null,
             ':a' => number_format((float) $amount, 2, '.', ''), ':ad' => $autoDetect ? 'true' : 'false',
             ':f' => $b['frequency'] ?? 'MONTHLY', ':sa' => $b['sourceAccountId'] ?? null,
             ':ap' => $autopay ? 'true' : 'false', ':n' => $nextRunAt]
        );
        Rewards::award($u['id'], 'recurring_bill.created');
        if ($autopay) Rewards::award($u['id'], 'recurring_bill.autopay_enabled');
        if ($autoDetect) Rewards::award($u['id'], 'recurring_bill.auto_detect_used');
        return Http::json($res, ['recurringBill' => self::shape($row)], 201);
    }

    public function autoDetect(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $biller = $b['billerName'] ?? null; $cat = $b['category'] ?? null;
        if (!$biller || !$cat) throw new ApiError('billerName + category required', 400);
        $q = BillProvider::fetchAmount($biller, $cat);
        Rewards::award($u['id'], 'recurring_bill.auto_detect_used');
        return Http::json($res, $q);
    }

    public function toggle(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $cur = Db::one('SELECT * FROM recurring_bills WHERE id=:i AND user_id=:u', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$cur) throw new ApiError('Not found', 404);
        $row = Db::one('UPDATE recurring_bills SET enabled = NOT enabled, updated_at=now() WHERE id=:i RETURNING *', [':i' => $args['id']]);
        return Http::json($res, ['recurringBill' => self::shape($row)]);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM recurring_bills WHERE id=:i AND user_id=:u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('Not found', 404);
        Rewards::award($u['id'], 'recurring_bill.deleted');
        return Http::json($res, ['message' => 'Recurring bill removed']);
    }

    public function history(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all(
            'SELECT r.* FROM recurring_bill_runs r JOIN recurring_bills b ON b.id = r.recurring_bill_id
             WHERE b.user_id = :u ORDER BY r.run_at DESC',
            [':u' => $u['id']]
        );
        return Http::json($res, ['runs' => $rows]);
    }
}
