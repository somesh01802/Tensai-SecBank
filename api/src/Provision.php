<?php
namespace Tensai;

/**
 * New-user provisioning — mirrors the Node register flow + demoDataSeed +
 * notifications.service. Reused by AuthController::register and the CLI seeder.
 */
class Provision
{
    /** Unique 10-digit account number. */
    public static function accountNumber(): string
    {
        for ($i = 0; $i < 6; $i++) {
            $n = (string) (1000000000 + random_int(0, 8999999999));
            $dup = Db::one('SELECT id FROM accounts WHERE account_number = :n', [':n' => $n]);
            if (!$dup) return $n;
        }
        throw new \RuntimeException('Could not allocate a unique account number');
    }

    /** Self-credit opening deposit — keeps the ledger consistent. */
    public static function openingDeposit(string $accountId, float $amount, string $key, string $desc, string $category): void
    {
        $tx = Db::one(
            'INSERT INTO transactions (from_account_id, to_account_id, amount, status, idempotency_key, description, category)
             VALUES (:a,:a,:amt,\'COMPLETED\',:k,:d,:c) RETURNING id',
            [':a' => $accountId, ':amt' => number_format($amount, 2, '.', ''), ':k' => $key, ':d' => $desc, ':c' => $category]
        );
        Db::run(
            'INSERT INTO ledger_entries (account_id, transaction_id, type, amount) VALUES (:a,:t,\'CREDIT\',:amt)',
            [':a' => $accountId, ':t' => $tx['id'], ':amt' => number_format($amount, 2, '.', '')]
        );
    }

    /** Full provisioning for a freshly-created user id. */
    public static function forUser(string $userId, string $userName): void
    {
        $acct = self::accountNumber();
        $account = Db::one(
            'INSERT INTO accounts (user_id, account_number, kind, display_name, is_primary, currency)
             VALUES (:u,:n,\'SAVINGS\',\'Primary Savings\',true,\'USD\') RETURNING id',
            [':u' => $userId, ':n' => $acct]
        );
        self::openingDeposit($account['id'], 100000, 'welcome-bonus-' . $account['id'], 'Tensai SecBank welcome bonus', 'WELCOME_BONUS');
        self::demoData($userId);
        self::welcomeNotifications($userId);
    }

    /** Investments + bills (no cards — users apply for those). Mirrors demoDataSeed. */
    public static function demoData(string $userId): void
    {
        $invs = [
            ['MUTUAL_FUND', 'Mutual funds', '30000.00', '35000.00', '5000.00', '7.21', '5,000 / month'],
            ['LIFE_INSURANCE', 'Life insurance', '700000.00', '700000.00', '3200.00', null, '3200 / month'],
            ['FIXED_DEPOSIT', 'Fixed Deposit', '150000.00', '156000.00', '12000.00', '6.00', '12000 / month'],
            ['STOCKS', 'Stocks', '45000.00', '49500.00', null, '10.00', 'invested amount · $45,000'],
        ];
        foreach ($invs as [$type, $name, $inv, $cur, $mon, $ret, $freq]) {
            Db::run(
                'INSERT INTO investments (user_id, type, name, invested_amount, current_value, monthly_contribution, return_pct, frequency_label)
                 VALUES (:u,:t,:n,:i,:c,:m,:r,:f)',
                [':u' => $userId, ':t' => $type, ':n' => $name, ':i' => $inv, ':c' => $cur, ':m' => $mon, ':r' => $ret, ':f' => $freq]
            );
        }
        $bills = [
            ['Phone recharge', 'PHONE', 'airtel', '599.00', 3],
            ['Credit card bill', 'CREDIT_CARD', 'cc', '12779.12', 5],
            ['EMI', 'EMI', 'percent', '8989.00', 8],
            ['Netflix', 'STREAMING', 'netflix', '299.00', 10],
        ];
        foreach ($bills as [$biller, $cat, $icon, $amt, $days]) {
            Db::run(
                'INSERT INTO bills (user_id, biller_name, category, icon_hint, amount, due_date, status)
                 VALUES (:u,:b,:c,:i,:a, now() + (:d || \' days\')::interval, \'DUE\')',
                [':u' => $userId, ':b' => $biller, ':c' => $cat, ':i' => $icon, ':a' => $amt, ':d' => $days]
            );
        }
    }

    public static function welcomeNotifications(string $userId): void
    {
        $items = [
            ['Welcome to Tensai SecBank!', 'Your account is ready. Start by exploring your dashboard.', 'WELCOME', 'SUCCESS', '/app'],
            ['Rewards await you', 'Complete tasks around the app to earn reward points.', 'REWARDS', 'INFO', '/app/rewards'],
            ['Personal loans at 10.99% p.a.', 'Pre-approved offer for you. Zero paperwork, instant disbursal.', 'LOANS', 'INFO', '/app/loans'],
            ['FD rates revised', 'Tensai Fixed Deposits now up to 7.35% p.a.', 'OFFERS', 'INFO', '/app/investments'],
            ['Enable AutoPay on your SIPs', 'Automate your monthly contributions.', 'INVESTMENTS', 'INFO', '/app/investments'],
            ['Try our Sapphire Credit Card', '10X rewards on all spends. See if you qualify.', 'CARDS', 'INFO', '/app/cards'],
            ['Set up recurring bills', 'Never miss a bill again. Enable AutoPay for utilities.', 'BILLS', 'INFO', '/app/bills'],
            ['Add your first payee', 'Send money faster by saving payees.', 'TRANSFERS', 'INFO', '/app/transfer'],
            ['Security tip', 'Never share your MPIN or CVV with anyone.', 'SECURITY', 'WARNING', null],
            ['Home loan @ 8.60% onwards', 'Balance transfer with processing fee waived.', 'LOANS', 'INFO', '/app/loans'],
        ];
        foreach ($items as [$title, $body, $cat, $sev, $url]) {
            Db::run(
                'INSERT INTO notifications (user_id, title, body, category, severity, action_url) VALUES (:u,:t,:b,:c,:s,:a)',
                [':u' => $userId, ':t' => $title, ':b' => $body, ':c' => $cat, ':s' => $sev, ':a' => $url]
            );
        }
    }
}
