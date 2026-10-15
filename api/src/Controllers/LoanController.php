<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Rewards};

class LoanController
{
    /** Reducing-balance EMI: P*r*(1+r)^n / ((1+r)^n - 1). */
    public static function computeEmi(float $principal, float $annualRate, int $tenureMonths): array
    {
        $r = $annualRate / 100 / 12;
        if ($r == 0.0) return ['emi' => round($principal / $tenureMonths, 2), 'totalInterest' => 0.0, 'totalRepayment' => round($principal, 2)];
        $factor = (1 + $r) ** $tenureMonths;
        $emi = ($principal * $r * $factor) / ($factor - 1);
        $total = $emi * $tenureMonths;
        return ['emi' => round($emi, 2), 'totalRepayment' => round($total, 2), 'totalInterest' => round($total - $principal, 2)];
    }

    private static function shapeProduct(array $p): array
    {
        return Db::floats($p, ['interestRate', 'minAmount', 'maxAmount']);
    }

    private static function shape(array $r): array
    {
        return Db::floats($r, ['principal', 'interestRate', 'emi', 'totalInterest', 'totalRepayment']);
    }

    public function listProducts(Request $req, Response $res): Response
    {
        $rows = Db::all('SELECT * FROM loan_products ORDER BY name');
        return Http::json($res, ['products' => array_map([self::class, 'shapeProduct'], $rows)]);
    }

    public function calculate(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $code = $b['productCode'] ?? null; $principal = $b['principal'] ?? null; $tenure = $b['tenureMonths'] ?? null;
        if (!$code || !$principal || !$tenure) throw new ApiError('productCode, principal and tenureMonths are required', 400);
        $p = Db::one('SELECT * FROM loan_products WHERE code = :c LIMIT 1', [':c' => $code]);
        if (!$p) throw new ApiError('Product not found', 404);
        $P = (float) $principal; $tenure = (int) $tenure;
        if ($P < (float) $p['minAmount'] || $P > (float) $p['maxAmount'])
            throw new ApiError("Amount must be between {$p['minAmount']} and {$p['maxAmount']}", 400);
        if ($tenure < (int) $p['minTenure'] || $tenure > (int) $p['maxTenure'])
            throw new ApiError("Tenure must be between {$p['minTenure']} and {$p['maxTenure']} months", 400);

        Rewards::award($u['id'], 'loan.emi.calculated');
        $calc = self::computeEmi($P, (float) $p['interestRate'], $tenure);
        return Http::json($res, array_merge([
            'product' => self::shapeProduct($p),
            'principal' => $P,
            'tenureMonths' => $tenure,
            'interestRate' => (float) $p['interestRate'],
        ], $calc));
    }

    public function apply(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $code = $b['productCode'] ?? null; $principal = $b['principal'] ?? null; $tenure = $b['tenureMonths'] ?? null;
        $p = Db::one('SELECT * FROM loan_products WHERE code = :c LIMIT 1', [':c' => $code]);
        if (!$p) throw new ApiError('Product not found', 404);
        $P = (float) $principal; $tenure = (int) $tenure;
        if (!$P || $P < (float) $p['minAmount'] || $P > (float) $p['maxAmount'])
            throw new ApiError("Amount must be between {$p['minAmount']} and {$p['maxAmount']}", 400);
        if (!$tenure || $tenure < (int) $p['minTenure'] || $tenure > (int) $p['maxTenure'])
            throw new ApiError("Tenure must be between {$p['minTenure']} and {$p['maxTenure']} months", 400);

        $calc = self::computeEmi($P, (float) $p['interestRate'], $tenure);
        $app = Db::one(
            'INSERT INTO loan_applications (user_id, product_id, principal, tenure_months, interest_rate, emi, total_interest, total_repayment, status)
             VALUES (:u,:pid,:pr,:tn,:ir,:emi,:ti,:tr,\'APPROVED\') RETURNING *',
            [':u' => $u['id'], ':pid' => $p['id'], ':pr' => number_format($P, 2, '.', ''), ':tn' => $tenure,
             ':ir' => number_format((float) $p['interestRate'], 3, '.', ''), ':emi' => number_format($calc['emi'], 2, '.', ''),
             ':ti' => number_format($calc['totalInterest'], 2, '.', ''), ':tr' => number_format($calc['totalRepayment'], 2, '.', '')]
        );
        Rewards::award($u['id'], 'loan.applied.first');
        Rewards::award($u['id'], "loan.applied.{$p['code']}");
        return Http::json($res, ['application' => self::shape($app)], 201);
    }

    public function listApplications(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM loan_applications WHERE user_id = :u ORDER BY created_at DESC', [':u' => $u['id']]);
        $products = Db::all('SELECT * FROM loan_products');
        $byId = [];
        foreach ($products as $p) $byId[$p['id']] = $p;
        return Http::json($res, ['applications' => array_map(function ($r) use ($byId) {
            $prod = $byId[$r['productId']] ?? null;
            return self::shape($r) + ['product' => $prod ? ['id' => $prod['id'], 'code' => $prod['code'], 'name' => $prod['name']] : null];
        }, $rows)]);
    }

    public function detail(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $app = Db::one('SELECT * FROM loan_applications WHERE id = :i AND user_id = :u LIMIT 1', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$app) throw new ApiError('Loan application not found', 404);
        $product = Db::one('SELECT * FROM loan_products WHERE id = :i LIMIT 1', [':i' => $app['productId']]);

        $P = (float) $app['principal']; $r = (float) $app['interestRate'] / 100 / 12; $emi = (float) $app['emi'];
        $tenure = (int) $app['tenureMonths'];
        $balance = $P; $schedule = [];
        for ($i = 1; $i <= min(6, $tenure); $i++) {
            $interest = $balance * $r;
            $principalPart = $emi - $interest;
            $balance = max(0, $balance - $principalPart);
            $schedule[] = ['n' => $i, 'emi' => round($emi, 2), 'interest' => round($interest, 2),
                'principal' => round($principalPart, 2), 'outstanding' => round($balance, 2)];
        }
        return Http::json($res, ['application' => self::shape($app), 'product' => $product, 'schedule' => $schedule]);
    }

    public function close(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $reason = ((array) $req->getParsedBody())['reason'] ?? null;
        $app = Db::one('SELECT * FROM loan_applications WHERE id = :i AND user_id = :u LIMIT 1', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$app) throw new ApiError('Loan application not found', 404);
        if (in_array($app['status'], ['CLOSED', 'REJECTED'], true)) throw new ApiError("Loan is already {$app['status']}", 400);

        $next = $app['status'] === 'PENDING' ? 'REJECTED' : 'CLOSED';
        $closeReason = ($reason && trim($reason) !== '') ? trim($reason) : ($next === 'REJECTED' ? 'Cancelled by user' : 'Closed by user');
        $updated = Db::one(
            'UPDATE loan_applications SET status=:s, closed_at=now(), close_reason=:r, updated_at=now() WHERE id=:i RETURNING *',
            [':s' => $next, ':r' => $closeReason, ':i' => $app['id']]
        );
        return Http::json($res, ['application' => self::shape($updated)]);
    }
}
