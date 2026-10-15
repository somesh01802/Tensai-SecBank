<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Rewards};

class AutopayController
{
    private static function shape(array $r): array { return Db::floats($r, ['amount']); }

    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM investment_autopay WHERE user_id = :u ORDER BY created_at DESC', [':u' => $u['id']]);
        return Http::json($res, ['autopays' => array_map([self::class, 'shape'], $rows)]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        foreach (['investmentId', 'sourceAccountId', 'amount', 'nextRunAt'] as $k)
            if (empty($b[$k])) throw new ApiError('investmentId, sourceAccountId, amount, nextRunAt required', 400);
        $row = Db::one(
            'INSERT INTO investment_autopay (user_id, investment_id, source_account_id, amount, frequency, next_run_at, enabled)
             VALUES (:u,:inv,:src,:amt,:f,:nr,true) RETURNING *',
            [':u' => $u['id'], ':inv' => $b['investmentId'], ':src' => $b['sourceAccountId'],
             ':amt' => number_format((float) $b['amount'], 2, '.', ''), ':f' => $b['frequency'] ?? 'MONTHLY', ':nr' => $b['nextRunAt']]
        );
        Rewards::award($u['id'], 'autopay.enabled');
        return Http::json($res, ['autopay' => self::shape($row)], 201);
    }

    public function toggle(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $cur = Db::one('SELECT * FROM investment_autopay WHERE id=:i AND user_id=:u', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$cur) throw new ApiError('AutoPay not found', 404);
        $row = Db::one('UPDATE investment_autopay SET enabled = NOT enabled, updated_at=now() WHERE id=:i RETURNING *', [':i' => $args['id']]);
        Rewards::award($u['id'], $row['enabled'] ? 'autopay.enabled' : 'autopay.disabled');
        return Http::json($res, ['autopay' => self::shape($row)]);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM investment_autopay WHERE id=:i AND user_id=:u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('AutoPay not found', 404);
        return Http::json($res, ['message' => 'AutoPay deleted']);
    }

    public function history(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all(
            'SELECT r.id, r.autopay_id, r.amount, r.status, r.reason, r.run_at
             FROM investment_autopay_runs r JOIN investment_autopay a ON a.id = r.autopay_id
             WHERE a.user_id = :u ORDER BY r.run_at DESC',
            [':u' => $u['id']]
        );
        return Http::json($res, ['runs' => $rows]);
    }
}
