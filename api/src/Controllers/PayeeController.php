<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Banks, Rewards};

class PayeeController
{
    public function banks(Request $req, Response $res): Response
    {
        return Http::json($res, ['banks' => Banks::LIST]);
    }

    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM payees WHERE user_id = :u ORDER BY created_at DESC', [':u' => $u['id']]);
        return Http::json($res, ['payees' => $rows]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $bank = $b['bankName'] ?? null; $acc = $b['accountNumber'] ?? null; $conf = $b['confirmAccountNumber'] ?? null;
        $holder = $b['accountHolderName'] ?? null; $nick = $b['nickname'] ?? null;
        if (!$bank || !$acc || !$conf || !$holder || !$nick) throw new ApiError('All fields are required', 400);
        if (!in_array($bank, Banks::LIST, true)) throw new ApiError('Unknown bank', 400);
        if ($acc !== $conf) throw new ApiError('Account numbers do not match', 400);
        if (!preg_match('/^\d{9,18}$/', $acc)) throw new ApiError('Account number must be 9–18 digits', 400);

        try {
            $row = Db::one(
                'INSERT INTO payees (user_id, bank_name, account_number, account_holder_name, nickname, active)
                 VALUES (:u,:b,:a,:h,:n,true) RETURNING *',
                [':u' => $u['id'], ':b' => $bank, ':a' => $acc, ':h' => trim($holder), ':n' => trim($nick)]
            );
        } catch (\PDOException $e) {
            if (str_contains($e->getMessage(), 'payees_user_acct_unique')) throw new ApiError('You already have a payee with this account number', 409);
            throw $e;
        }
        Rewards::award($u['id'], 'payee.added.first');
        Rewards::award($u['id'], 'payee.acct_match');
        if (trim($nick) !== '') Rewards::award($u['id'], 'payee.nickname.custom');
        $all = Db::all('SELECT id FROM payees WHERE user_id = :u', [':u' => $u['id']]);
        if (count($all) >= 3) Rewards::award($u['id'], 'payee.count.gte.3');
        return Http::json($res, ['payee' => $row], 201);
    }

    public function update(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $sets = []; $params = [':i' => $args['id'], ':u' => $u['id']];
        if (array_key_exists('nickname', $b) && $b['nickname'] !== null) { $sets[] = 'nickname = :n'; $params[':n'] = $b['nickname']; }
        if (array_key_exists('accountHolderName', $b) && $b['accountHolderName'] !== null) { $sets[] = 'account_holder_name = :h'; $params[':h'] = $b['accountHolderName']; }
        $active = null;
        if (array_key_exists('active', $b) && $b['active'] !== null) { $active = (bool) $b['active']; $sets[] = 'active = :a'; $params[':a'] = $active ? 'true' : 'false'; }
        if (!$sets) throw new ApiError('No changes', 400);
        $sets[] = 'updated_at = now()';
        $row = Db::one('UPDATE payees SET ' . implode(', ', $sets) . ' WHERE id=:i AND user_id=:u RETURNING *', $params);
        if (!$row) throw new ApiError('Payee not found', 404);
        if ($active === false) Rewards::award($u['id'], 'payee.deactivated');
        if ($active === true) Rewards::award($u['id'], 'payee.reactivated');
        return Http::json($res, ['payee' => $row]);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $n = Db::run('DELETE FROM payees WHERE id=:i AND user_id=:u', [':i' => $args['id'], ':u' => $u['id']]);
        if ($n === 0) throw new ApiError('Payee not found', 404);
        Rewards::award($u['id'], 'payee.deleted');
        return Http::json($res, ['message' => 'Payee removed']);
    }
}
