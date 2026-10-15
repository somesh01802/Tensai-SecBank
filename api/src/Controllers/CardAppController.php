<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Rewards};
use PDO;

class CardAppController
{
    private static function digits(int $n): string
    {
        $s = '';
        for ($i = 0; $i < $n; $i++) $s .= random_int(0, 9);
        return $s;
    }

    private static function shapeProduct(array $r): array
    {
        return [
            'id' => $r['id'], 'code' => $r['code'], 'category' => $r['category'],
            'cardType' => $r['cardType'], 'name' => $r['name'], 'tagline' => $r['tagline'],
            'benefits' => isset($r['benefits']) ? (json_decode($r['benefits'], true) ?: []) : [],
            'annualFee' => isset($r['annualFee']) ? (float) $r['annualFee'] : null,
            'colorHint' => $r['colorHint'] ?? null, 'network' => $r['network'] ?? null,
        ];
    }

    public function listProducts(Request $req, Response $res): Response
    {
        $q = $req->getQueryParams();
        $sql = 'SELECT id, code, category, card_type, name, tagline, benefits::text AS benefits, annual_fee, color_hint, network FROM card_products';
        $conds = []; $params = [];
        if (!empty($q['category'])) { $conds[] = 'category = ?'; $params[] = $q['category']; }
        if (!empty($q['type'])) { $conds[] = 'card_type = ?'; $params[] = $q['type']; }
        if ($conds) $sql .= ' WHERE ' . implode(' AND ', $conds);
        $rows = Db::all($sql, $params);
        return Http::json($res, ['products' => array_map([self::class, 'shapeProduct'], $rows)]);
    }

    public function apply(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $code = $b['productCode'] ?? null; $mobile = $b['mobileNumber'] ?? null;
        $pan = $b['pan'] ?? null; $dob = $b['dob'] ?? null;
        if (!$code || !$mobile || !$pan || !$dob) throw new ApiError('productCode, mobileNumber, pan, dob required', 400);
        if (!preg_match('/^\d{10}$/', $mobile)) throw new ApiError('Mobile number must be 10 digits', 400);
        if (!preg_match('/^[A-Z]{5}[0-9]{4}[A-Z]$/', $pan)) throw new ApiError('Invalid PAN format', 400);

        $p = Db::one('SELECT id, code, category, card_type, name, tagline, color_hint, network FROM card_products WHERE code = :c LIMIT 1', [':c' => $code]);
        if (!$p) throw new ApiError('Card product not found', 404);

        $full = '5' . self::digits(15);
        $cvv = self::digits(3);
        $expiryMonth = ((((int) date('n') - 1) + random_int(0, 11)) % 12) + 1;
        $expiryYear = ((int) date('Y') + 3) % 100;
        $holder = $u['name'] ?: 'Card Holder';

        $out = Db::tx(function (PDO $pdo) use ($u, $p, $full, $cvv, $expiryMonth, $expiryYear, $holder, $mobile, $pan, $dob) {
            $st = $pdo->prepare(
                "INSERT INTO cards (user_id, holder_name, product_id, last_four, full_number, cvv,
                    expiry_month, expiry_year, type, brand, color_hint, network)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *"
            );
            $st->execute([$u['id'], $holder, $p['id'], substr($full, -4), $full, $cvv,
                $expiryMonth, $expiryYear, $p['cardType'], $p['network'], $p['colorHint'], $p['network']]);
            $card = Db::camelizeRow($st->fetch());

            $ast = $pdo->prepare(
                "INSERT INTO card_applications (user_id, product_id, mobile_number, pan, dob, status, card_id, processed_at)
                 VALUES (?,?,?,?,?,'APPROVED',?, now()) RETURNING *"
            );
            $ast->execute([$u['id'], $p['id'], $mobile, $pan, substr($dob, 0, 10), $card['id']]);
            $app = Db::camelizeRow($ast->fetch());
            return ['card' => $card, 'application' => $app];
        });

        Rewards::award($u['id'], 'card.applied.first');
        Rewards::award($u['id'], "card.applied.{$p['cardType']}");
        Rewards::award($u['id'], "card.applied.{$p['category']}");
        Rewards::award($u['id'], 'card.app.dob');
        Rewards::award($u['id'], 'card.app.pan');
        $active = Db::one('SELECT COUNT(*)::int AS n FROM cards WHERE user_id = :u AND deleted_at IS NULL', [':u' => $u['id']]);
        if ((int) $active['n'] >= 2) Rewards::award($u['id'], 'card.active.gte.2');

        return Http::json($res, ['application' => $out['application'], 'card' => CardController::mask($out['card'])], 201);
    }

    public function listApplications(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM card_applications WHERE user_id = :u', [':u' => $u['id']]);
        return Http::json($res, ['applications' => $rows]);
    }

    public function reveal(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $c = Db::one('SELECT * FROM cards WHERE id = :i AND user_id = :u LIMIT 1', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$c) throw new ApiError('Card not found', 404);
        Rewards::award($u['id'], 'card.number.revealed');
        Rewards::award($u['id'], 'card.cvv.revealed');
        return Http::json($res, [
            'fullNumber' => $c['fullNumber'],
            'cvv' => $c['cvv'],
            'expiry' => str_pad((string) $c['expiryMonth'], 2, '0', STR_PAD_LEFT) . '/' . str_pad((string) $c['expiryYear'], 2, '0', STR_PAD_LEFT),
        ]);
    }
}
