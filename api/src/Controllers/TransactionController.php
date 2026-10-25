<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Attempts};
use PDO;

class TransactionController
{
    private static function shape(array $t): array
    {
        return [
            '_id' => $t['id'], 'id' => $t['id'],
            'fromAccount' => $t['fromAccountId'], 'toAccount' => $t['toAccountId'],
            'amount' => (float) $t['amount'], 'status' => $t['status'],
            'idempotencyKey' => $t['idempotencyKey'], 'description' => $t['description'],
            'category' => $t['category'], 'createdAt' => $t['createdAt'], 'updatedAt' => $t['updatedAt'] ?? null,
        ];
    }

    /** POST /api/transactions — internal transfer, ACID, balance-checked. */
    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $from = $b['fromAccount'] ?? null; $to = $b['toAccount'] ?? null;
        $amount = $b['amount'] ?? null; $key = $b['idempotencyKey'] ?? null; $desc = $b['description'] ?? null;

        $meta = ['amount' => $amount, 'sourceAccountId' => $from, 'idempotencyKey' => $key,
                 'target' => $to ? 'account ' . Attempts::mask((string) $to) : null];
        return Attempts::run($req, $res, $u, 'P2P', $meta, fn() => $this->transfer($u, $from, $to, $amount, $key, $desc));
    }

    /** @return array{0: array, 1: int, 2: ?string} [payload, HTTP status, transaction id] */
    private function transfer(array $u, $from, $to, $amount, $key, $desc): array
    {
        if (!$from || !$to || !$amount || !$key)
            throw new ApiError('fromAccount, toAccount, amount and idempotencyKey are required', 400);
        $amt = (float) $amount;
        if (!is_finite($amt) || $amt <= 0) throw new ApiError('amount must be a positive number', 400);
        if ($from === $to) throw new ApiError('Cannot transfer to the same account', 400);
        if (!Attempts::isUuid($from) || !Attempts::isUuid($to)) throw new ApiError('Invalid fromAccount or toAccount', 404);

        $existing = Db::one('SELECT * FROM transactions WHERE idempotency_key = :k', [':k' => $key]);
        if ($existing) {
            if ($existing['status'] === 'COMPLETED') return [['message' => 'Transaction already processed', 'transaction' => self::shape($existing)], 200, $existing['id']];
            if ($existing['status'] === 'PENDING') return [['message' => 'Transaction is still processing', 'transaction' => self::shape($existing)], 200, $existing['id']];
            throw new ApiError("Transaction previously {$existing['status']}, retry with a new idempotency key", 409, ['transaction' => self::shape($existing)]);
        }

        $fromAcc = Db::one('SELECT * FROM accounts WHERE id = :a', [':a' => $from]);
        $toAcc = Db::one('SELECT * FROM accounts WHERE id = :a', [':a' => $to]);
        if (!$fromAcc || !$toAcc) throw new ApiError('Invalid fromAccount or toAccount', 404);
        if ($fromAcc['userId'] !== $u['id']) throw new ApiError('You do not own the source account', 403);
        if ($fromAcc['status'] !== 'ACTIVE' || $toAcc['status'] !== 'ACTIVE') throw new ApiError('Both accounts must be ACTIVE', 400);

        // Synthetic (test) money never mixes with live customer money, in either direction.
        $owners = Db::one('SELECT (SELECT is_synthetic FROM users WHERE id = :f) AS f, (SELECT is_synthetic FROM users WHERE id = :t) AS t',
            [':f' => $fromAcc['userId'], ':t' => $toAcc['userId']]);
        if ((bool) $owners['f'] !== (bool) $owners['t'])
            throw new ApiError('Transfers between test and live accounts are not allowed', 400);

        try {
            $completed = Db::tx(function (PDO $pdo) use ($from, $to, $amt, $key, $desc) {
                $a = number_format($amt, 2, '.', '');
                $st = $pdo->prepare("INSERT INTO transactions (from_account_id,to_account_id,amount,status,idempotency_key,description)
                    VALUES (?,?,?,'PENDING',?,?) RETURNING *");
                $st->execute([$from, $to, $a, $key, $desc]);
                $tx = $st->fetch();
                $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,'DEBIT',?)")
                    ->execute([$from, $tx['id'], $a]);
                $bst = $pdo->prepare("SELECT COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS bal FROM ledger_entries WHERE account_id = ?");
                $bst->execute([$from]);
                if ((float) $bst->fetch()['bal'] < 0) throw new ApiError('INSUFFICIENT_BALANCE', 400);
                $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,'CREDIT',?)")
                    ->execute([$to, $tx['id'], $a]);
                $ust = $pdo->prepare("UPDATE transactions SET status='COMPLETED', updated_at=now() WHERE id=? RETURNING *");
                $ust->execute([$tx['id']]);
                return Db::camelizeRow($ust->fetch());
            });
        } catch (ApiError $e) {
            if ($e->getMessage() === 'INSUFFICIENT_BALANCE') {
                $bal = AccountController::balances([$from])[$from] ?? 0;
                throw new ApiError('Insufficient balance. Available: ' . $bal . ', Requested: ' . $amt, 400);
            }
            throw $e;
        }

        return [['message' => 'Transaction completed successfully', 'transaction' => self::shape($completed)], 201, $completed['id']];
    }

    /** GET /api/transactions?from=&to=&limit= */
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $accts = Db::all('SELECT id FROM accounts WHERE user_id = :u', [':u' => $u['id']]);
        if (!$accts) return Http::json($res, ['transactions' => [], 'totals' => ['count' => 0, 'credit' => 0, 'debit' => 0]]);
        $ids = array_column($accts, 'id');
        $idSet = array_flip($ids);

        [$from, $to] = self::dateRange($req->getQueryParams());
        $limit = min((int) ($req->getQueryParams()['limit'] ?? 500) ?: 500, 2000);

        $in = implode(',', array_fill(0, count($ids), '?'));
        $params = array_merge($ids, $ids);
        $sql = "SELECT * FROM transactions WHERE (from_account_id IN ($in) OR to_account_id IN ($in))";
        if ($from) { $sql .= ' AND created_at >= ?'; $params[] = $from; }
        if ($to)   { $sql .= ' AND created_at <= ?'; $params[] = $to; }
        $sql .= ' ORDER BY created_at DESC LIMIT ' . $limit;

        $rows = Db::all($sql, $params);
        $txs = array_map(function ($t) use ($idSet) {
            $self = $t['fromAccountId'] === $t['toAccountId'];
            $of = isset($idSet[$t['fromAccountId']]); $ot = isset($idSet[$t['toAccountId']]);
            $dir = $self ? (in_array($t['category'], ['WELCOME_BONUS', 'DEPOSIT'], true) ? 'IN' : 'OUT')
                : ($of && $ot ? 'OUT' : ($of ? 'OUT' : 'IN'));
            return self::shape($t) + ['direction' => $dir];
        }, $rows);

        $credit = 0; $debit = 0;
        foreach ($txs as $t) {
            if ($t['status'] !== 'COMPLETED') continue;
            if ($t['direction'] === 'IN') $credit += $t['amount']; else $debit += $t['amount'];
        }
        return Http::json($res, ['transactions' => $txs, 'totals' => ['count' => count($txs), 'credit' => $credit, 'debit' => $debit], 'filter' => ['from' => $from, 'to' => $to]]);
    }

    /** POST /api/transactions/receive — deposit into primary. */
    public function receive(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $amount = $b['amount'] ?? null; $key = $b['idempotencyKey'] ?? null;
        $remarks = $b['remarks'] ?? null; $src = $b['sourceInfo'] ?? null;
        if (!$amount || !$key) throw new ApiError('amount and idempotencyKey are required', 400);
        $amt = (float) $amount;
        if (!is_finite($amt) || $amt <= 0) throw new ApiError('amount must be positive', 400);
        if ($amt > 100000000) throw new ApiError('amount exceeds allowed limit', 400);

        $dup = Db::one('SELECT * FROM transactions WHERE idempotency_key = :k', [':k' => $key]);
        if ($dup) return Http::json($res, ['message' => 'Already credited', 'transaction' => self::shape($dup)]);

        $primary = Db::one('SELECT * FROM accounts WHERE user_id = :u AND is_primary = true LIMIT 1', [':u' => $u['id']]);
        if (!$primary) throw new ApiError('No primary account found', 400);
        if ($primary['status'] !== 'ACTIVE') throw new ApiError('Primary account is not active', 400);

        $desc = $remarks ? ('Received: ' . $remarks . ($src ? ' · from ' . $src : '')) : ('Deposit' . ($src ? ' from ' . $src : ''));
        $completed = Db::tx(function (PDO $pdo) use ($primary, $amt, $key, $desc) {
            $a = number_format($amt, 2, '.', '');
            $st = $pdo->prepare("INSERT INTO transactions (from_account_id,to_account_id,amount,status,idempotency_key,description,category)
                VALUES (?,?,?,'COMPLETED',?,?,'DEPOSIT') RETURNING *");
            $st->execute([$primary['id'], $primary['id'], $a, $key, $desc]);
            $tx = $st->fetch();
            $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,'CREDIT',?)")
                ->execute([$primary['id'], $tx['id'], $a]);
            return Db::camelizeRow($tx);
        });
        return Http::json($res, ['message' => 'Deposit credited', 'transaction' => self::shape($completed)], 201);
    }

    /** POST /api/transactions/system/initial-funds (system user only). */
    public function initialFunds(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $to = $b['toAccount'] ?? null; $amount = $b['amount'] ?? null; $key = $b['idempotencyKey'] ?? null;
        if (!$to || !$amount || !$key) throw new ApiError('toAccount, amount and idempotencyKey are required', 400);

        $sys = Db::one('SELECT * FROM accounts WHERE user_id = :u LIMIT 1', [':u' => $u['id']]);
        if (!$sys) $sys = Db::one('INSERT INTO accounts (user_id) VALUES (:u) RETURNING *', [':u' => $u['id']]);
        $amt = number_format((float) $amount, 2, '.', '');

        $completed = Db::tx(function (PDO $pdo) use ($sys, $to, $amt, $key) {
            $st = $pdo->prepare("INSERT INTO transactions (from_account_id,to_account_id,amount,status,idempotency_key) VALUES (?,?,?,'COMPLETED',?) RETURNING *");
            $st->execute([$sys['id'], $to, $amt, $key]);
            $tx = $st->fetch();
            $le = $pdo->prepare("INSERT INTO ledger_entries (account_id,transaction_id,type,amount) VALUES (?,?,?,?)");
            $le->execute([$sys['id'], $tx['id'], 'DEBIT', $amt]);
            $le->execute([$to, $tx['id'], 'CREDIT', $amt]);
            return Db::camelizeRow($tx);
        });
        return Http::json($res, ['message' => 'Initial funds transaction completed', 'transaction' => self::shape($completed)], 201);
    }

    /** GET /api/transactions/statement.csv?from=&to= */
    public function statement(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $accts = Db::all('SELECT * FROM accounts WHERE user_id = :u', [':u' => $u['id']]);
        if (!$accts) {
            $res->getBody()->write("No accounts\n");
            return $res->withHeader('Content-Type', 'text/csv')->withHeader('Content-Disposition', 'attachment; filename="statement.csv"');
        }
        $ids = array_column($accts, 'id');
        $primary = null;
        foreach ($accts as $a) if ($a['isPrimary']) { $primary = $a; break; }
        if (!$primary) $primary = $accts[0];

        [$from, $to] = self::dateRange($req->getQueryParams());
        $in = implode(',', array_fill(0, count($ids), '?'));
        $params = array_merge($ids, $ids);
        $sql = "SELECT * FROM transactions WHERE (from_account_id IN ($in) OR to_account_id IN ($in))";
        if ($from) { $sql .= ' AND created_at >= ?'; $params[] = $from; }
        if ($to)   { $sql .= ' AND created_at <= ?'; $params[] = $to; }
        $sql .= ' ORDER BY created_at ASC';
        $rows = Db::all($sql, $params);

        $running = 0.0;
        if ($from) {
            $pr = Db::one("SELECT COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END),0) AS total
                FROM ledger_entries WHERE account_id = :a AND created_at < :f", [':a' => $primary['id'], ':f' => $from]);
            $running = (float) $pr['total'];
        }

        $lines = ['Date/Time,Reference,Description,Category,Type,Direction,Debit,Credit,Balance,Status'];
        foreach ($rows as $t) {
            $of = in_array($t['fromAccountId'], $ids, true); $ot = in_array($t['toAccountId'], $ids, true);
            $dir = $t['fromAccountId'] === $t['toAccountId']
                ? (in_array($t['category'], ['WELCOME_BONUS', 'DEPOSIT'], true) ? 'IN' : 'OUT')
                : ($of && $ot ? ($t['fromAccountId'] === $primary['id'] ? 'OUT' : 'IN') : ($of ? 'OUT' : 'IN'));
            $affects = $t['fromAccountId'] === $primary['id'] || $t['toAccountId'] === $primary['id'];
            $amt = (float) $t['amount'];
            if ($affects) {
                if (in_array($t['category'], ['WELCOME_BONUS', 'DEPOSIT'], true)) $running += $amt;
                elseif ($t['fromAccountId'] === $primary['id']) $running -= $amt;
                elseif ($t['toAccountId'] === $primary['id']) $running += $amt;
            }
            $lines[] = implode(',', [
                self::csv(date('c', strtotime($t['createdAt']))),
                self::csv(substr($t['id'], 0, 8)),
                self::csv($t['description'] ?? ''),
                self::csv($t['category'] ?? ''),
                self::csv('Transfer'),
                self::csv($dir),
                $dir === 'OUT' ? number_format($amt, 2, '.', '') : '',
                $dir === 'IN' ? number_format($amt, 2, '.', '') : '',
                $affects ? number_format($running, 2, '.', '') : '',
                self::csv($t['status']),
            ]);
        }
        $fn = 'tensai-statement-' . substr($from ?: '1970-01-01', 0, 10) . '_to_' . substr($to ?: date('c'), 0, 10) . '.csv';
        $res->getBody()->write(implode("\n", $lines));
        return $res->withHeader('Content-Type', 'text/csv')->withHeader('Content-Disposition', "attachment; filename=\"$fn\"");
    }

    private static function dateRange(array $q): array
    {
        $from = !empty($q['from']) ? $q['from'] : null;
        $to = !empty($q['to']) ? $q['to'] : null;
        if ($from && $to && strtotime($from) > strtotime($to)) { [$from, $to] = [$to, $from]; }
        return [$from, $to];
    }

    private static function csv($v): string
    {
        $s = (string) ($v ?? '');
        return preg_match('/[",\n]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
    }
}
