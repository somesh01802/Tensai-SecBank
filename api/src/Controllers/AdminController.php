<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Attempts, Audit};

/**
 * Admin API (/api/admin/*). Every route is behind Auth(role: ADMIN), and every
 * call is written to audit_logs. Columns are always selected explicitly:
 * password hashes, MPINs, full card numbers, CVVs and tokens are never read.
 */
class AdminController
{
    private const BAL = "COALESCE(SUM(CASE WHEN le.type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0)";

    // ---------------------------------------------------------------- helpers
    private static function page(array $q): array
    {
        $page = max(1, (int) ($q['page'] ?? 1));
        $size = min(100, max(1, (int) ($q['pageSize'] ?? 20)));
        return [$page, $size, ($page - 1) * $size];
    }

    private static function maskMobile(?string $m): ?string
    {
        return $m ? str_repeat('•', max(0, strlen($m) - 4)) . substr($m, -4) : null;
    }

    private static function audit(Request $req, string $event, ?string $entity = null, ?string $entityId = null, array $meta = []): void
    {
        Audit::log($req, $req->getAttribute('user')['id'], $event, $entity, $entityId, $meta);
    }

    /** WHERE builder with unique placeholder names (native PDO prepares forbid re-use). */
    private static function where(array $conds): string
    {
        return $conds ? 'WHERE ' . implode(' AND ', $conds) : '';
    }

    // ---------------------------------------------------------------- summary
    public function summary(Request $req, Response $res): Response
    {
        self::audit($req, 'admin.view_summary');
        $c = Db::one("SELECT count(*) FILTER (WHERE NOT is_synthetic) AS real, count(*) FILTER (WHERE is_synthetic) AS synthetic
                      FROM users WHERE role = 'CUSTOMER' AND NOT is_system_user");
        $a = Db::one("SELECT count(*) AS accounts,
                             (SELECT " . self::BAL . " FROM ledger_entries le JOIN accounts x ON x.id = le.account_id
                               JOIN users u ON u.id = x.user_id WHERE NOT u.is_synthetic AND NOT u.is_system_user) AS real_balance
                      FROM accounts WHERE status = 'ACTIVE'");
        $att = Db::one("SELECT count(*) AS total, count(*) FILTER (WHERE outcome = 'SUCCESS') AS success,
                               count(*) FILTER (WHERE outcome = 'FAILURE') AS failure,
                               COALESCE(round(avg(duration_ms)), 0) AS avg_ms
                        FROM transaction_attempts WHERE created_at >= now() - interval '24 hours'");
        $cats = Db::all("SELECT error_category AS category, count(*) AS n FROM transaction_attempts
                         WHERE outcome = 'FAILURE' AND created_at >= now() - interval '24 hours'
                         GROUP BY error_category ORDER BY n DESC LIMIT 10");
        $fb = Db::all("SELECT COALESCE(rating, 'DISMISSED') AS rating, count(*) AS n FROM transaction_feedback GROUP BY 1 ORDER BY n DESC");
        $logins = Db::one("SELECT count(*) FILTER (WHERE outcome = 'success') AS success, count(*) FILTER (WHERE outcome = 'failure') AS failure
                           FROM login_events WHERE event = 'login' AND created_at >= now() - interval '24 hours'");
        return Http::json($res, [
            'customers' => ['real' => (int) $c['real'], 'synthetic' => (int) $c['synthetic']],
            'accounts' => ['active' => (int) $a['accounts'], 'realBalance' => (float) $a['realBalance']],
            'attempts24h' => ['total' => (int) $att['total'], 'success' => (int) $att['success'],
                'failure' => (int) $att['failure'], 'avgDurationMs' => (int) $att['avgMs'],
                'failureCategories' => array_map(fn($r) => ['category' => $r['category'], 'count' => (int) $r['n']], $cats)],
            'feedback' => array_map(fn($r) => ['rating' => $r['rating'], 'count' => (int) $r['n']], $fb),
            'logins24h' => ['success' => (int) $logins['success'], 'failure' => (int) $logins['failure']],
        ]);
    }

    // -------------------------------------------------------------- customers
    public function customers(Request $req, Response $res): Response
    {
        $q = $req->getQueryParams();
        [$page, $size, $offset] = self::page($q);
        $search = trim((string) ($q['q'] ?? ''));
        $synthetic = $q['synthetic'] ?? 'all';

        $conds = ["u.role = 'CUSTOMER'", 'NOT u.is_system_user'];
        $p = [];
        if ($search !== '') {
            $conds[] = '(u.name ILIKE :s1 OR u.email ILIKE :s2 OR u.mobile_number LIKE :s3 OR u.id::text = :s4)';
            $p += [':s1' => "%$search%", ':s2' => "%$search%", ':s3' => "%$search%", ':s4' => strtolower($search)];
        }
        if ($synthetic === 'real') $conds[] = 'NOT u.is_synthetic';
        if ($synthetic === 'synthetic') $conds[] = 'u.is_synthetic';
        $where = self::where($conds);

        $total = (int) Db::one("SELECT count(*) AS n FROM users u $where", $p)['n'];
        $rows = Db::all("
            SELECT u.id, u.name, u.email, u.mobile_number, u.is_synthetic, u.created_at,
                   (SELECT count(*) FROM accounts a WHERE a.user_id = u.id) AS accounts_count,
                   (SELECT " . self::BAL . " FROM ledger_entries le JOIN accounts a ON a.id = le.account_id WHERE a.user_id = u.id) AS total_balance,
                   (SELECT max(l.created_at) FROM login_events l WHERE l.user_id = u.id AND l.event = 'login' AND l.outcome = 'success') AS last_login_at
            FROM users u $where ORDER BY u.created_at DESC LIMIT $size OFFSET $offset", $p);
        self::audit($req, 'admin.view_customers', 'user', null, ['q' => $search, 'synthetic' => $synthetic, 'page' => $page]);

        return Http::json($res, ['total' => $total, 'page' => $page, 'pageSize' => $size, 'items' => array_map(fn($r) => [
            'id' => $r['id'], 'name' => $r['name'], 'email' => $r['email'], 'mobile' => self::maskMobile($r['mobileNumber']),
            'isSynthetic' => (bool) $r['isSynthetic'], 'createdAt' => $r['createdAt'], 'accountsCount' => (int) $r['accountsCount'],
            'totalBalance' => (float) $r['totalBalance'], 'lastLoginAt' => $r['lastLoginAt'],
        ], $rows)]);
    }

    public function customer(Request $req, Response $res, array $args): Response
    {
        $id = $args['id'] ?? '';
        $u = Attempts::isUuid($id) ? Db::one(
            "SELECT id, name, email, mobile_number, occupation, role, is_synthetic, created_at FROM users
             WHERE id = :id AND role = 'CUSTOMER'", [':id' => $id]) : null;
        if (!$u) throw new ApiError('Customer not found', 404);
        self::audit($req, 'admin.view_customer', 'user', $id);

        $accounts = Db::all("
            SELECT a.id, a.account_number, a.kind, a.status, a.is_primary, a.currency, a.display_name, a.created_at, " . self::BAL . " AS balance
            FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
            WHERE a.user_id = :u GROUP BY a.id ORDER BY a.created_at", [':u' => $id]);
        // Explicit safe columns only — never full_number / cvv.
        $cards = Db::all("SELECT id, holder_name, last_four, expiry_month, expiry_year, type, network, is_frozen, created_at
                          FROM cards WHERE user_id = :u AND deleted_at IS NULL ORDER BY created_at DESC", [':u' => $id]);
        $loans = Db::all("SELECT la.id, lp.name AS product, la.principal, la.tenure_months, la.interest_rate, la.emi, la.status, la.created_at
                          FROM loan_applications la JOIN loan_products lp ON lp.id = la.product_id
                          WHERE la.user_id = :u ORDER BY la.created_at DESC", [':u' => $id]);
        $bills = Db::all("SELECT id, biller_name, category, amount, due_date, status, paid_at FROM bills
                          WHERE user_id = :u ORDER BY created_at DESC LIMIT 50", [':u' => $id]);
        $txns = Db::all("
            SELECT t.id, t.amount, t.status, t.category, t.description, t.created_at,
                   CASE WHEN fa.user_id = :u1 THEN 'DEBIT' ELSE 'CREDIT' END AS direction
            FROM transactions t JOIN accounts fa ON fa.id = t.from_account_id JOIN accounts ta ON ta.id = t.to_account_id
            WHERE fa.user_id = :u2 OR ta.user_id = :u3 ORDER BY t.created_at DESC LIMIT 25", [':u1' => $id, ':u2' => $id, ':u3' => $id]);
        $attempts = Db::all("
            SELECT a.id, a.kind, a.amount, a.outcome, a.error_category, a.error_message, a.target, a.duration_ms, a.transaction_id, a.created_at,
                   f.rating AS feedback_rating, f.status AS feedback_status
            FROM transaction_attempts a LEFT JOIN transaction_feedback f ON f.attempt_id = a.id
            WHERE a.user_id = :u ORDER BY a.created_at DESC LIMIT 25", [':u' => $id]);
        $logins = Db::all("
            SELECT l.id, l.event, l.outcome, l.method, l.created_at, COALESCE(ll.status, 'unknown') AS location_status,
                   round(ll.latitude, 2) AS latitude, round(ll.longitude, 2) AS longitude
            FROM login_events l LEFT JOIN login_locations ll ON ll.login_event_id = l.id
            WHERE l.user_id = :u ORDER BY l.created_at DESC LIMIT 15", [':u' => $id]);

        $u['mobile'] = self::maskMobile($u['mobileNumber']);
        unset($u['mobileNumber']);
        return Http::json($res, [
            'customer' => $u,
            'accounts' => array_map(fn($r) => Db::floats($r, ['balance']), $accounts),
            'cards' => $cards,
            'loans' => array_map(fn($r) => Db::floats($r, ['principal', 'interestRate', 'emi']), $loans),
            'bills' => array_map(fn($r) => Db::floats($r, ['amount']), $bills),
            'transactions' => array_map(fn($r) => Db::floats($r, ['amount']), $txns),
            'attempts' => array_map(fn($r) => Db::floats($r, ['amount']), $attempts),
            'logins' => array_map(fn($r) => Db::floats($r, ['latitude', 'longitude']), $logins),
        ]);
    }

    // ----------------------------------------------------------- transactions
    /** Completed/legacy transactions + failed attempts (which never created a transaction), one list. */
    private const UNIFIED = "
        SELECT t.id AS ref_id, 'TRANSACTION' AS ref_type, t.created_at, t.amount, t.status::text AS status,
               CASE WHEN t.status = 'COMPLETED' THEN 'SUCCESS' WHEN t.status = 'PENDING' THEN 'PENDING' ELSE 'FAILURE' END AS outcome,
               a.kind, t.category, t.description, a.error_category, a.duration_ms,
               fu.id AS user_id, fu.name AS user_name, fu.email AS user_email, fu.is_synthetic,
               CASE WHEN t.from_account_id = t.to_account_id THEN NULL ELSE tu.name END AS counterparty,
               f.rating AS feedback_rating, f.status AS feedback_status
        FROM transactions t
        JOIN accounts fa ON fa.id = t.from_account_id JOIN users fu ON fu.id = fa.user_id
        JOIN accounts ta ON ta.id = t.to_account_id   JOIN users tu ON tu.id = ta.user_id
        LEFT JOIN (SELECT DISTINCT ON (transaction_id) * FROM transaction_attempts
                   -- the ORIGINAL attempt that created the transaction (idempotent retries link to it too)
                   WHERE transaction_id IS NOT NULL ORDER BY transaction_id, created_at ASC) a ON a.transaction_id = t.id
        LEFT JOIN transaction_feedback f ON f.attempt_id = a.id
        UNION ALL
        SELECT a.id, 'ATTEMPT', a.created_at, a.amount, CASE WHEN a.outcome = 'SUCCESS' THEN 'COMPLETED' ELSE 'FAILED' END,
               a.outcome, a.kind, a.category, a.error_message, a.error_category,
               a.duration_ms, u.id, u.name, u.email, u.is_synthetic, a.target, f.rating, f.status
        FROM transaction_attempts a JOIN users u ON u.id = a.user_id
        LEFT JOIN transaction_feedback f ON f.attempt_id = a.id
        WHERE a.transaction_id IS NULL";

    public function transactions(Request $req, Response $res): Response
    {
        $q = $req->getQueryParams();
        [$page, $size, $offset] = self::page($q);
        $conds = []; $p = [];
        if (($s = trim((string) ($q['q'] ?? ''))) !== '') {
            $conds[] = '(x.user_name ILIKE :q1 OR x.user_email ILIKE :q2 OR x.description ILIKE :q3 OR x.ref_id::text = :q4)';
            $p += [':q1' => "%$s%", ':q2' => "%$s%", ':q3' => "%$s%", ':q4' => strtolower($s)];
        }
        if (in_array($q['outcome'] ?? '', ['SUCCESS', 'FAILURE', 'PENDING'], true)) { $conds[] = 'x.outcome = :oc'; $p[':oc'] = $q['outcome']; }
        if (in_array($q['kind'] ?? '', ['P2P', 'EXTERNAL', 'BILL'], true)) { $conds[] = 'x.kind = :kd'; $p[':kd'] = $q['kind']; }
        if (($c = (string) ($q['errorCategory'] ?? '')) !== '') { $conds[] = 'x.error_category = :ec'; $p[':ec'] = $c; }
        if (($q['synthetic'] ?? 'all') === 'real') $conds[] = 'NOT x.is_synthetic';
        if (($q['synthetic'] ?? 'all') === 'synthetic') $conds[] = 'x.is_synthetic';
        if (!empty($q['from']) && strtotime($q['from'])) { $conds[] = 'x.created_at >= :df'; $p[':df'] = date('c', strtotime($q['from'])); }
        if (!empty($q['to']) && strtotime($q['to'])) { $conds[] = 'x.created_at < :dt'; $p[':dt'] = date('c', strtotime($q['to'] . ' +1 day')); }
        $where = self::where($conds);

        $total = (int) Db::one("SELECT count(*) AS n FROM (" . self::UNIFIED . ") x $where", $p)['n'];
        $rows = Db::all("SELECT * FROM (" . self::UNIFIED . ") x $where ORDER BY x.created_at DESC LIMIT $size OFFSET $offset", $p);
        self::audit($req, 'admin.view_transactions', 'transaction', null, ['filters' => array_intersect_key($q,
            array_flip(['q', 'outcome', 'kind', 'errorCategory', 'synthetic', 'from', 'to'])), 'page' => $page]);
        return Http::json($res, ['total' => $total, 'page' => $page, 'pageSize' => $size,
            'items' => array_map(fn($r) => Db::floats($r, ['amount']), $rows)]);
    }

    public function transaction(Request $req, Response $res, array $args): Response
    {
        $id = $args['id'] ?? '';
        if (!Attempts::isUuid($id)) throw new ApiError('Transaction not found', 404);
        $attemptCols = 'a.id, a.user_id, a.session_id, a.kind, a.category, a.amount, a.currency, a.source_account_id, a.target,
            a.transaction_id, a.outcome, a.error_category, a.error_message, a.http_status, a.duration_ms, a.trace_id,
            a.is_synthetic, a.fault_injected, a.created_at, f.status AS feedback_status, f.rating AS feedback_rating,
            f.comment AS feedback_comment, f.created_at AS feedback_at';

        $tx = Db::one("
            SELECT t.id, t.amount, t.status, t.category, t.description, t.idempotency_key, t.created_at, t.updated_at,
                   fa.id AS from_account_id, fa.account_number AS from_account_number, fu.id AS from_user_id, fu.name AS from_user,
                   ta.id AS to_account_id, ta.account_number AS to_account_number, tu.id AS to_user_id, tu.name AS to_user
            FROM transactions t
            JOIN accounts fa ON fa.id = t.from_account_id JOIN users fu ON fu.id = fa.user_id
            JOIN accounts ta ON ta.id = t.to_account_id   JOIN users tu ON tu.id = ta.user_id
            WHERE t.id = :id", [':id' => $id]);
        if ($tx) {
            $ledger = Db::all('SELECT account_id, type, amount, created_at FROM ledger_entries WHERE transaction_id = :id ORDER BY created_at',
                [':id' => $id]);
            $attempts = Db::all("SELECT $attemptCols FROM transaction_attempts a LEFT JOIN transaction_feedback f ON f.attempt_id = a.id
                                 WHERE a.transaction_id = :id ORDER BY a.created_at", [':id' => $id]);
            self::audit($req, 'admin.view_transaction', 'transaction', $id);
            return Http::json($res, ['type' => 'TRANSACTION', 'transaction' => Db::floats($tx, ['amount']),
                'ledger' => array_map(fn($r) => Db::floats($r, ['amount']), $ledger),
                'attempts' => array_map(fn($r) => Db::floats($r, ['amount']), $attempts)]);
        }
        $att = Db::one("SELECT $attemptCols, u.name AS user_name, u.email AS user_email
                        FROM transaction_attempts a JOIN users u ON u.id = a.user_id
                        LEFT JOIN transaction_feedback f ON f.attempt_id = a.id WHERE a.id = :id", [':id' => $id]);
        if (!$att) throw new ApiError('Transaction not found', 404);
        self::audit($req, 'admin.view_transaction', 'transaction_attempt', $id);
        return Http::json($res, ['type' => 'ATTEMPT', 'attempt' => Db::floats($att, ['amount'])]);
    }

    // --------------------------------------------------------------- feedback
    public function feedback(Request $req, Response $res): Response
    {
        $q = $req->getQueryParams();
        [$page, $size, $offset] = self::page($q);
        $conds = []; $p = [];
        if (in_array($q['rating'] ?? '', ['HAPPY', 'SATISFIED', 'NOT_SATISFIED'], true)) { $conds[] = 'f.rating = :r'; $p[':r'] = $q['rating']; }
        if (($q['rating'] ?? '') === 'DISMISSED') $conds[] = "f.status = 'DISMISSED'";
        if (in_array($q['outcome'] ?? '', ['SUCCESS', 'FAILURE'], true)) { $conds[] = 'a.outcome = :o'; $p[':o'] = $q['outcome']; }
        $where = self::where($conds);
        $from = "FROM transaction_feedback f JOIN transaction_attempts a ON a.id = f.attempt_id JOIN users u ON u.id = f.user_id";
        $total = (int) Db::one("SELECT count(*) AS n $from $where", $p)['n'];
        $rows = Db::all("SELECT f.id, f.status, f.rating, f.comment, f.created_at, a.id AS attempt_id, a.kind, a.amount, a.outcome,
                                a.error_category, a.transaction_id, u.id AS user_id, u.name AS user_name, u.is_synthetic
                         $from $where ORDER BY f.created_at DESC LIMIT $size OFFSET $offset", $p);
        self::audit($req, 'admin.view_feedback', 'transaction_feedback', null, ['rating' => $q['rating'] ?? null, 'page' => $page]);
        return Http::json($res, ['total' => $total, 'page' => $page, 'pageSize' => $size,
            'items' => array_map(fn($r) => Db::floats($r, ['amount']), $rows)]);
    }

    // ------------------------------------------------------------------ audit
    public function auditLog(Request $req, Response $res): Response
    {
        [$page, $size, $offset] = self::page($req->getQueryParams());
        $total = (int) Db::one("SELECT count(*) AS n FROM audit_logs WHERE event_type LIKE 'admin.%'")['n'];
        $rows = Db::all("SELECT l.id, l.event_type, l.entity, l.entity_id, l.metadata, l.ip, l.created_at, u.name AS actor, u.email AS actor_email
                         FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
                         WHERE l.event_type LIKE 'admin.%' ORDER BY l.created_at DESC LIMIT $size OFFSET $offset");
        self::audit($req, 'admin.view_audit', 'audit_logs', null, ['page' => $page]);
        return Http::json($res, ['total' => $total, 'page' => $page, 'pageSize' => $size, 'items' => array_map(function ($r) {
            $r['metadata'] = json_decode((string) $r['metadata'], true) ?: [];
            return $r;
        }, $rows)]);
    }
}
