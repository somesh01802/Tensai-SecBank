<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError};

class BeneficiaryController
{
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all(
            'SELECT b.id, b.nickname, b.to_account_id, b.created_at,
                    ac.status AS beneficiary_account_status, us.name AS beneficiary_owner_name
             FROM beneficiaries b JOIN accounts ac ON ac.id = b.to_account_id JOIN users us ON us.id = ac.user_id
             WHERE b.user_id = :u ORDER BY b.created_at DESC',
            [':u' => $u['id']]
        );
        return Http::json($res, ['beneficiaries' => $rows]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $nickname = $b['nickname'] ?? null; $to = $b['toAccountId'] ?? null;
        if (!$nickname || !$to) throw new ApiError('nickname and toAccountId are required', 400);
        $target = Db::one('SELECT user_id FROM accounts WHERE id = :a', [':a' => $to]);
        if (!$target) throw new ApiError('Target account not found', 404);
        if ($target['userId'] === $u['id']) throw new ApiError('Cannot add your own account as a beneficiary', 400);
        try {
            $row = Db::one('INSERT INTO beneficiaries (user_id, nickname, to_account_id) VALUES (:u,:n,:a) RETURNING *',
                [':u' => $u['id'], ':n' => trim($nickname), ':a' => $to]);
        } catch (\PDOException $e) {
            if (str_contains($e->getMessage(), 'beneficiaries_user_account_unique')) throw new ApiError('This account is already a beneficiary', 409);
            throw $e;
        }
        return Http::json($res, ['beneficiary' => $row], 201);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM beneficiaries WHERE id = :i AND user_id = :u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('Beneficiary not found', 404);
        return Http::json($res, ['message' => 'Beneficiary removed']);
    }
}
