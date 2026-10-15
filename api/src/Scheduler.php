<?php
namespace Tensai;

/**
 * Scheduler — one tick processes all due items. Mirrors the Node scheduler:
 *   1) investment AutoPay contributions
 *   2) recurring bills (autopay)
 *   3) scheduled transfers
 * Each item is isolated; one failure never blocks the rest and is recorded on
 * the matching *_runs table. Invoke via bin/scheduler.php from cron / a timer.
 */
class Scheduler
{
    public static function tick(): void
    {
        try { self::processAutopay(); } catch (\Throwable $e) { error_log('[scheduler autopay] ' . $e->getMessage()); }
        try { self::processRecurringBills(); } catch (\Throwable $e) { error_log('[scheduler recurring] ' . $e->getMessage()); }
        try { self::processScheduledTransfers(); } catch (\Throwable $e) { error_log('[scheduler transfers] ' . $e->getMessage()); }
    }

    private static function processAutopay(): void
    {
        $due = Db::all('SELECT * FROM investment_autopay WHERE enabled = true AND next_run_at <= now()');
        foreach ($due as $a) {
            $idem = 'autopay-' . $a['id'] . '-' . self::iso($a['nextRunAt']);
            try {
                $tx = Ledger::debit($a['sourceAccountId'], $a['amount'], $idem, 'Investment AutoPay', 'INVESTMENTS');
                Db::run('INSERT INTO investment_autopay_runs (autopay_id, amount, status, transaction_id) VALUES (:i,:a,\'SUCCESS\',:t)',
                    [':i' => $a['id'], ':a' => $a['amount'], ':t' => $tx['id']]);
                Db::run('UPDATE investments SET invested_amount = invested_amount + :a, current_value = current_value + :a WHERE id = :i',
                    [':a' => number_format((float) $a['amount'], 2, '.', ''), ':i' => $a['investmentId']]);
                Rewards::award($a['userId'], 'autopay.ran');
            } catch (\Throwable $err) {
                Db::run('INSERT INTO investment_autopay_runs (autopay_id, amount, status, reason) VALUES (:i,:a,\'FAILED\',:r)',
                    [':i' => $a['id'], ':a' => $a['amount'], ':r' => self::reason($err)]);
            }
            $next = Schedule::advance($a['nextRunAt'], $a['frequency']);
            Db::run('UPDATE investment_autopay SET next_run_at = :n, enabled = :e, updated_at = now() WHERE id = :i',
                [':n' => $next ?? $a['nextRunAt'], ':e' => $next ? ($a['enabled'] ? 'true' : 'false') : 'false', ':i' => $a['id']]);
        }
    }

    private static function processRecurringBills(): void
    {
        $due = Db::all('SELECT * FROM recurring_bills WHERE enabled = true AND next_run_at <= now()');
        foreach ($due as $b) {
            $effective = (float) $b['amount'];
            if ($b['autoDetectAmount']) $effective = (float) BillProvider::fetchAmount($b['billerName'], $b['category'])['amount'];
            $amtStr = number_format($effective, 2, '.', '');
            $idem = 'recur-' . $b['id'] . '-' . self::iso($b['nextRunAt']);
            try {
                $txId = null;
                if ($b['autopayEnabled'] && $b['sourceAccountId']) {
                    $tx = Ledger::debit($b['sourceAccountId'], $effective, $idem, 'Recurring bill · ' . $b['billerName'], $b['category']);
                    $txId = $tx['id'];
                }
                $bill = Db::one(
                    'INSERT INTO bills (user_id, biller_name, category, amount, status, paid_at, paid_tx_id)
                     VALUES (:u,:bn,:c,:a,:s,:pa,:pt) RETURNING id',
                    [':u' => $b['userId'], ':bn' => $b['billerName'], ':c' => $b['category'], ':a' => $amtStr,
                     ':s' => $txId ? 'PAID' : 'DUE', ':pa' => $txId ? date('c') : null, ':pt' => $txId]
                );
                Db::run('INSERT INTO recurring_bill_runs (recurring_bill_id, amount, status, transaction_id, bill_id) VALUES (:r,:a,:s,:t,:b)',
                    [':r' => $b['id'], ':a' => $amtStr, ':s' => $txId ? 'SUCCESS' : 'SCHEDULED', ':t' => $txId, ':b' => $bill['id']]);
                Rewards::award($b['userId'], 'recurring_bill.ran');
            } catch (\Throwable $err) {
                Db::run('INSERT INTO recurring_bill_runs (recurring_bill_id, amount, status, reason) VALUES (:r,:a,\'FAILED\',:reason)',
                    [':r' => $b['id'], ':a' => $amtStr, ':reason' => self::reason($err)]);
            }
            $next = Schedule::advance($b['nextRunAt'], $b['frequency']);
            Db::run('UPDATE recurring_bills SET next_run_at = :n, enabled = :e, amount = :a, updated_at = now() WHERE id = :i',
                [':n' => $next ?? $b['nextRunAt'], ':e' => $next ? ($b['enabled'] ? 'true' : 'false') : 'false', ':a' => $amtStr, ':i' => $b['id']]);
        }
    }

    private static function processScheduledTransfers(): void
    {
        $due = Db::all('SELECT * FROM scheduled_transfers WHERE enabled = true AND next_run_at <= now()');
        foreach ($due as $s) {
            Db::run('UPDATE scheduled_transfers SET status=\'PROCESSING\', updated_at=now() WHERE id = :i', [':i' => $s['id']]);
            $idem = 'sched-' . $s['id'] . '-' . self::iso($s['nextRunAt']);
            $ranStatus = 'FAILED';
            try {
                $tx = Ledger::debit($s['sourceAccountId'], $s['amount'], $idem, $s['remarks'] ?: 'Scheduled transfer', 'TRANSFER_EXTERNAL');
                Db::run('INSERT INTO scheduled_transfer_runs (scheduled_transfer_id, amount, status, transaction_id) VALUES (:i,:a,\'SUCCESS\',:t)',
                    [':i' => $s['id'], ':a' => $s['amount'], ':t' => $tx['id']]);
                $ranStatus = 'COMPLETED';
                Rewards::award($s['userId'], 'scheduled_transfer.ran');
            } catch (\Throwable $err) {
                Db::run('INSERT INTO scheduled_transfer_runs (scheduled_transfer_id, amount, status, reason) VALUES (:i,:a,\'FAILED\',:r)',
                    [':i' => $s['id'], ':a' => $s['amount'], ':r' => self::reason($err)]);
            }
            $next = Schedule::advance($s['nextRunAt'], $s['frequency']);
            // On a recurring item requeue to SCHEDULED; on a one-shot keep the run's terminal status.
            Db::run('UPDATE scheduled_transfers SET next_run_at = :n, enabled = :e, status = :s, updated_at = now() WHERE id = :i',
                [':n' => $next ?? $s['nextRunAt'], ':e' => $next ? 'true' : 'false',
                 ':s' => $next ? 'SCHEDULED' : $ranStatus, ':i' => $s['id']]);
        }
    }

    private static function iso($ts): string { return date('c', strtotime((string) $ts)); }

    private static function reason(\Throwable $err): string
    {
        return ($err instanceof ApiError && $err->getMessage() === 'INSUFFICIENT_BALANCE') ? 'Insufficient balance' : $err->getMessage();
    }
}
