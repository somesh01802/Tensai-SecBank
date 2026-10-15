<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Rewards};

class CardController
{
    public static function mask(array $c): array { unset($c['fullNumber'], $c['cvv']); return $c; }
    private static function digits(int $n): string { $s = ''; for ($i = 0; $i < $n; $i++) $s .= random_int(0, 9); return $s; }

    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM cards WHERE user_id = :u AND deleted_at IS NULL ORDER BY created_at', [':u' => $u['id']]);
        return Http::json($res, ['cards' => array_map([self::class, 'mask'], $rows)]);
    }

    public function create(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $holder = trim($b['holderName'] ?? $u['name'] ?? 'Card Holder');
        $type = $b['type'] ?? 'CREDIT'; $brand = $b['brand'] ?? 'MASTERCARD';
        $full = '5' . self::digits(15);
        $row = Db::one(
            'INSERT INTO cards (user_id, account_id, holder_name, last_four, full_number, cvv, expiry_month, expiry_year, type, brand, color_hint, network)
             VALUES (:u,:acc,:h,:l4,:fn,:cvv,:em,:ey,:t,:br,:col,:net) RETURNING *',
            [':u' => $u['id'], ':acc' => $b['accountId'] ?? null, ':h' => $holder, ':l4' => substr($full, -4),
             ':fn' => $full, ':cvv' => self::digits(3), ':em' => random_int(1, 12), ':ey' => ((int) date('Y') + 3) % 100,
             ':t' => $type, ':br' => $brand, ':col' => $b['colorHint'] ?? 'peach', ':net' => $brand]
        );
        return Http::json($res, ['card' => self::mask($row)], 201);
    }

    public function freeze(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $c = Db::one('SELECT * FROM cards WHERE id=:i AND user_id=:u AND deleted_at IS NULL', [':i' => $args['id'], ':u' => $u['id']]);
        if (!$c) throw new ApiError('Card not found', 404);
        $row = Db::one('UPDATE cards SET is_frozen = NOT is_frozen WHERE id=:i RETURNING *', [':i' => $args['id']]);
        Rewards::award($u['id'], $row['isFrozen'] ? 'card.frozen' : 'card.unfrozen');
        return Http::json($res, ['card' => self::mask($row)]);
    }

    public function delete(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $row = Db::one('UPDATE cards SET deleted_at = now() WHERE id=:i AND user_id=:u AND deleted_at IS NULL RETURNING id',
            [':i' => $args['id'], ':u' => $u['id']]);
        if (!$row) throw new ApiError('Card not found', 404);
        Rewards::award($u['id'], 'card.cancelled');
        return Http::json($res, ['message' => 'Card cancelled']);
    }
}
