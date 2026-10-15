<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Provision, Rewards};

class AccountAppController
{
    private const KINDS = ['SAVINGS', 'SALARY', 'NRI', 'BUSINESS', 'INVESTMENT'];
    private const NAMES = [
        'SAVINGS' => 'Savings Account', 'SALARY' => 'Salary Account', 'NRI' => 'NRI Account',
        'BUSINESS' => 'Business Account', 'INVESTMENT' => 'Investment Account',
    ];

    public function apply(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $kind = $b['kind'] ?? null;
        $name = $b['applicantName'] ?? null; $pan = $b['pan'] ?? null; $pin = $b['pinCode'] ?? null;
        $occ = $b['occupation'] ?? null; $mobile = $b['mobileNumber'] ?? null; $extra = $b['extra'] ?? [];

        if (!in_array($kind, self::KINDS, true)) throw new ApiError('Invalid account type', 400);
        if (!$name || !$pan || !$pin || !$occ || !$mobile) throw new ApiError('All fields are required', 400);
        if (!preg_match('/^[A-Z]{5}[0-9]{4}[A-Z]$/', $pan)) throw new ApiError('PAN must match format AAAAA9999A', 400);
        if (!preg_match('/^\d{6}$/', $pin)) throw new ApiError('PIN code must be 6 digits', 400);
        if (!preg_match('/^\d{10}$/', $mobile)) throw new ApiError('Mobile number must be 10 digits', 400);

        $acctNo = Provision::accountNumber();
        $account = Db::one(
            'INSERT INTO accounts (user_id, account_number, kind, display_name) VALUES (:u,:n,:k,:d) RETURNING *',
            [':u' => $u['id'], ':n' => $acctNo, ':k' => $kind, ':d' => self::NAMES[$kind]]
        );
        $application = Db::one(
            'INSERT INTO account_applications (user_id, kind, applicant_name, pan, pin_code, occupation, mobile_number, extra, status, account_id, processed_at)
             VALUES (:u,:k,:an,:pan,:pin,:occ,:mob,:ex,\'APPROVED\',:acc, now()) RETURNING *',
            [':u' => $u['id'], ':k' => $kind, ':an' => $name, ':pan' => $pan, ':pin' => $pin, ':occ' => $occ,
             ':mob' => $mobile, ':ex' => json_encode((object) $extra), ':acc' => $account['id']]
        );
        Db::run('UPDATE users SET pan=:p, pin_code=:pc, occupation=:o, mobile_number=:m WHERE id=:u',
            [':p' => $pan, ':pc' => $pin, ':o' => $occ, ':m' => $mobile, ':u' => $u['id']]);

        Rewards::award($u['id'], 'account.opened.any');
        Rewards::award($u['id'], "account.opened.$kind");
        Rewards::award($u['id'], 'account.pin_code.valid');
        $all = Db::all('SELECT id FROM accounts WHERE user_id = :u', [':u' => $u['id']]);
        if (count($all) >= 2) Rewards::award($u['id'], 'account.count.gte.2');
        if (count($all) >= 3) Rewards::award($u['id'], 'account.count.gte.3');

        return Http::json($res, ['application' => $application, 'account' => $account], 201);
    }

    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM account_applications WHERE user_id = :u', [':u' => $u['id']]);
        return Http::json($res, ['applications' => $rows]);
    }
}
