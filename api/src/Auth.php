<?php
namespace Tensai;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\RequestHandlerInterface as Handler;
use Psr\Http\Message\ResponseInterface as Response;
use Slim\Psr7\Response as SlimResponse;

/**
 * Auth middleware. Reads the JWT from the Authorization: Bearer header or the
 * `token` cookie, rejects revoked tokens, loads the user, and attaches it to
 * the request as the `user` attribute. Mirrors the Node auth.middleware.
 */
class Auth
{
    public function __construct(private bool $requireSystem = false) {}

    public function __invoke(Request $req, Handler $handler): Response
    {
        $token = self::bearer($req) ?? ($req->getCookieParams()['token'] ?? null);
        if (!$token) return self::unauth('Unauthorized: token is missing');

        // Revoked (logged-out) tokens are rejected.
        $revoked = Db::one('SELECT token FROM revoked_tokens WHERE token = :t', [':t' => $token]);
        if ($revoked) return self::unauth('Unauthorized: token is revoked');

        $userId = Token::verify($token);
        if (!$userId) return self::unauth('Unauthorized: token is invalid');

        $user = Db::one(
            'SELECT id, email, name, mobile_number, is_system_user FROM users WHERE id = :id',
            [':id' => $userId]
        );
        if (!$user) return self::unauth('Unauthorized: user not found');

        if ($this->requireSystem && ($user['isSystemUser'] ?? false) !== true) {
            $res = new SlimResponse();
            return Http::json($res, ['message' => 'Forbidden: system user required'], 403);
        }

        $req = $req->withAttribute('user', $user)->withAttribute('token', $token);
        return $handler->handle($req);
    }

    public static function bearer(Request $req): ?string
    {
        $h = $req->getHeaderLine('Authorization');
        if (stripos($h, 'Bearer ') === 0) return substr($h, 7);
        return null;
    }

    private static function unauth(string $msg): Response
    {
        $res = new SlimResponse();
        return Http::json($res, ['message' => $msg], 401);
    }
}
