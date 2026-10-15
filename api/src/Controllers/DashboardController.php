<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http};

class DashboardController
{
    public function summary(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user'); $uid = $u['id'];

        $accounts = Db::all('SELECT * FROM accounts WHERE user_id = :u ORDER BY created_at', [':u' => $uid]);
        $invs = Db::all('SELECT * FROM investments WHERE user_id = :u', [':u' => $uid]);
        $cards = Db::all('SELECT * FROM cards WHERE user_id = :u', [':u' => $uid]);
        $bills = Db::all('SELECT * FROM bills WHERE user_id = :u', [':u' => $uid]);

        $ids = array_column($accounts, 'id');
        $bal = AccountController::balances($ids);
        $accountsWithBalance = array_map(fn($a) => $a + ['balance' => $bal[$a['id']] ?? 0], $accounts);
        $totalBalance = array_sum(array_column($accountsWithBalance, 'balance'));
        $primaryAccount = $accountsWithBalance[0] ?? null;

        $idSet = array_flip($ids);
        $recentTransactions = [];
        if ($ids) {
            $in = implode(',', array_fill(0, count($ids), '?'));
            $recent = Db::all(
                "SELECT * FROM transactions WHERE from_account_id IN ($in) OR to_account_id IN ($in)
                 ORDER BY created_at DESC LIMIT 10",
                array_merge($ids, $ids)
            );
            $recentTransactions = array_map(fn($t) => [
                'id' => $t['id'], 'fromAccount' => $t['fromAccountId'], 'toAccount' => $t['toAccountId'],
                'amount' => (float) $t['amount'], 'status' => $t['status'], 'description' => $t['description'],
                'category' => $t['category'], 'createdAt' => $t['createdAt'],
                'direction' => isset($idSet[$t['fromAccountId']]) ? 'OUT' : 'IN',
            ], $recent);
        }

        $expenditureByCategory = []; $statistics = [];
        if ($ids) {
            $in = implode(',', array_fill(0, count($ids), '?'));
            $cutoff = date('c', time() - 30 * 86400);
            $exp = Db::all(
                "SELECT COALESCE(category,'Other') AS category, SUM(amount) AS total
                 FROM transactions WHERE from_account_id IN ($in) AND status='COMPLETED' AND created_at >= ?
                 GROUP BY COALESCE(category,'Other')",
                array_merge($ids, [$cutoff])
            );
            $expenditureByCategory = array_map(fn($r) => ['category' => $r['category'], 'total' => (float) $r['total']], $exp);

            $st = Db::all(
                "SELECT DATE(created_at) AS day,
                        SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END) AS net
                 FROM ledger_entries WHERE account_id IN ($in) AND created_at >= ?
                 GROUP BY DATE(created_at) ORDER BY DATE(created_at)",
                array_merge($ids, [$cutoff])
            );
            $statistics = array_map(fn($r) => ['day' => $r['day'], 'net' => (float) $r['net']], $st);
        }

        $benef = Db::all(
            'SELECT b.id, b.nickname, b.to_account_id, us.name AS beneficiary_owner_name
             FROM beneficiaries b JOIN accounts ac ON ac.id = b.to_account_id JOIN users us ON us.id = ac.user_id
             WHERE b.user_id = :u LIMIT 6',
            [':u' => $uid]
        );

        $invShaped = array_map(fn($i) => Db::floats($i, ['investedAmount', 'currentValue', 'monthlyContribution', 'returnPct']), $invs);
        $cardsSafe = array_map(function ($c) { unset($c['fullNumber'], $c['cvv']); return $c; }, $cards);
        $billsUnpaid = array_values(array_map(
            fn($b) => Db::floats($b, ['amount']),
            array_filter($bills, fn($b) => $b['status'] !== 'PAID')
        ));

        return Http::json($res, [
            'totalBalance' => $totalBalance,
            'accounts' => $accountsWithBalance,
            'primaryAccount' => $primaryAccount,
            'investments' => $invShaped,
            'cards' => $cardsSafe,
            'bills' => $billsUnpaid,
            'recentTransactions' => $recentTransactions,
            'expenditureByCategory' => $expenditureByCategory,
            'statistics' => $statistics,
            'quickTransfer' => $benef,
        ]);
    }
}
