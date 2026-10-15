<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError};

class InvestmentController
{
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM investments WHERE user_id = :u ORDER BY created_at', [':u' => $u['id']]);
        return Http::json($res, ['investments' => $rows]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $type = $b['type'] ?? null; $name = $b['name'] ?? null; $inv = $b['investedAmount'] ?? null;
        if (!$type || !$name || $inv === null) throw new ApiError('type, name and investedAmount are required', 400);
        $cur = isset($b['currentValue']) && $b['currentValue'] !== null ? (float) $b['currentValue'] : (float) $inv;
        $mon = isset($b['monthlyContribution']) && $b['monthlyContribution'] !== null ? number_format((float) $b['monthlyContribution'], 2, '.', '') : null;
        $ret = isset($b['returnPct']) && $b['returnPct'] !== null ? number_format((float) $b['returnPct'], 2, '.', '') : null;
        $row = Db::one(
            'INSERT INTO investments (user_id, type, name, invested_amount, current_value, monthly_contribution, return_pct, frequency_label)
             VALUES (:u,:t,:n,:i,:c,:m,:r,:f) RETURNING *',
            [':u' => $u['id'], ':t' => $type, ':n' => $name, ':i' => number_format((float) $inv, 2, '.', ''),
             ':c' => number_format($cur, 2, '.', ''), ':m' => $mon, ':r' => $ret, ':f' => $b['frequencyLabel'] ?? null]
        );
        return Http::json($res, ['investment' => $row], 201);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM investments WHERE id = :i AND user_id = :u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('Investment not found', 404);
        return Http::json($res, ['message' => 'Investment removed']);
    }
}
