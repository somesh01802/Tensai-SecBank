<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Rewards, Attempts, Ledger};

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
        // The card may only be linked to one of the caller's own accounts.
        if (!empty($b['accountId']) && !\Tensai\Ledger::ownedActive($b['accountId'], $u['id'])) throw new ApiError('Account not found', 404);
        $row = Db::one(
            'INSERT INTO cards (user_id, account_id, holder_name, last_four, full_number, cvv, expiry_month, expiry_year, type, brand, color_hint, network)
             VALUES (:u,:acc,:h,:l4,:fn,:cvv,:em,:ey,:t,:br,:col,:net) RETURNING *',
            // VAPT-06: card number encrypted at rest; no CVV stored (derived on reveal).
            [':u' => $u['id'], ':acc' => $b['accountId'] ?? null, ':h' => $holder, ':l4' => substr($full, -4),
             ':fn' => \Tensai\Crypto::encrypt($full), ':cvv' => null, ':em' => random_int(1, 12), ':ey' => ((int) date('Y') + 3) % 100,
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

    /** POST /api/cards/{id}/pay { amount, merchant, fromAccountId?, idempotencyKey? } — card purchase, debits the card's account. */
    public function pay(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $merchant = substr(trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) ($b['merchant'] ?? 'Merchant'))), 0, 80) ?: 'Merchant';
        $key = isset($b['idempotencyKey']) ? substr((string) $b['idempotencyKey'], 0, 200) : 'card-pay-' . bin2hex(random_bytes(12));
        \Tensai\Mpin::stepUp($req, $u);   // VAPT-05
        return Attempts::run($req, $res, $u, 'CARD',
            ['amount' => $b['amount'] ?? null, 'category' => 'CARD_PAYMENT', 'target' => $merchant, 'idempotencyKey' => $key],
            function (array &$meta) use ($u, $b, $args, $merchant, $key) {
                $c = Attempts::isUuid($args['id'] ?? null)
                    ? Db::one('SELECT id, account_id, is_frozen FROM cards WHERE id=:i AND user_id=:u AND deleted_at IS NULL',
                        [':i' => $args['id'], ':u' => $u['id']])
                    : null;
                if (!$c) throw new ApiError('Card not found', 404);
                if ($c['isFrozen']) throw new ApiError('Card is frozen', 403);
                $from = $c['accountId'] ?? ($b['fromAccountId'] ?? null);
                $acc = Attempts::isUuid($from)
                    ? Db::one('SELECT id, status FROM accounts WHERE id = :a AND user_id = :u', [':a' => $from, ':u' => $u['id']])
                    : null;
                if (!$acc) throw new ApiError('Source account not found', 404);
                if ($acc['status'] !== 'ACTIVE') throw new ApiError('Source account is not active', 400);
                $meta['sourceAccountId'] = $acc['id'];
                try {
                    $tx = Ledger::debit($acc['id'], $meta['amount'], $key, 'Card payment · ' . $merchant, 'SHOPPING');
                } catch (ApiError $e) {
                    if ($e->getMessage() === 'INSUFFICIENT_BALANCE')
                        throw new ApiError('Insufficient balance', 400, ['available' => $e->extra['available'] ?? null]);
                    throw $e;
                }
                return [['message' => 'Card payment approved', 'transaction' => $tx], 201, $tx['id']];
            });
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
