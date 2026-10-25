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
 * `$requireRole` enforces a role (e.g. 'ADMIN') from the database row — never
 * from the token or the client — and audits every denied attempt.
 */
class Auth
{
    public function __construct(private bool $requireSystem = false, private ?string $requireRole = null) {}

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
            'SELECT id, email, name, mobile_number, is_system_user, role, is_synthetic FROM users WHERE id = :id',
            [':id' => $userId]
        );
        if (!$user) return self::unauth('Unauthorized: user not found');

        if ($this->requireSystem && ($user['isSystemUser'] ?? false) !== true) {
            $res = new SlimResponse();
            return Http::json($res, ['message' => 'Forbidden: system user required'], 403);
        }
        if ($this->requireRole && ($user['role'] ?? null) !== $this->requireRole) {
            Audit::log($req, $user['id'], 'admin.access_denied', 'route', null,
                ['path' => $req->getUri()->getPath(), 'method' => $req->getMethod(), 'role' => $user['role'] ?? null]);
            Apm::label('failure_reason', 'role required: ' . $this->requireRole);
            return Http::json(new SlimResponse(), ['message' => 'Forbidden: admin access required'], 403);
        }

        // Attribute this request's APM transaction to the user (user.* in Kibana).
        Apm::setUser($user['id'], $user['name'], $user['email'] ?? null);
        Apm::correlate($req, $user);

        $req = $req->withAttribute('user', $user)->withAttribute('token', $token);
        return $handler->handle($req);
    }

    public static function bearer(Request $req): ?string
    {
        // Apache + php-fpm drop the Authorization header unless `CGIPassAuth On`
        // (see api/README.md); after a FallbackResource internal redirect it can
        // arrive as REDIRECT_HTTP_AUTHORIZATION instead.
        $h = $req->getHeaderLine('Authorization')
            ?: (string) ($req->getServerParams()['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (stripos($h, 'Bearer ') === 0) return substr($h, 7);
        return null;
    }

    private static function unauth(string $msg): Response
    {
        $res = new SlimResponse();
        return Http::json($res, ['message' => $msg], 401);
    }
}
