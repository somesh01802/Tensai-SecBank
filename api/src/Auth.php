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
            'SELECT id, email, name, mobile_number, is_system_user, role, is_synthetic,
                    floor(extract(epoch FROM sessions_valid_after) * 1000)::bigint AS valid_after, session_keep_hash
             FROM users WHERE id = :id',
            [':id' => $userId]
        );
        if (!$user) return self::unauth('Unauthorized: user not found');
        // VAPT-09: a password or MPIN change ends every older session except the one that made the change.
        if ($user['validAfter'] !== null && Token::issuedAtMs($token) <= (int) $user['validAfter']
            && !hash_equals((string) $user['sessionKeepHash'], hash('sha256', $token)))
            return self::unauth('Unauthorized: session ended after a credential change');
        unset($user['validAfter'], $user['sessionKeepHash']);

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
        Journey::$user = $user;

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

    /** End all other sessions of a user (VAPT-09); the token used for this request keeps working. */
    public static function endOtherSessions(string $userId, ?string $currentToken): void
    {
        Db::run("UPDATE users SET sessions_valid_after = clock_timestamp(), session_keep_hash = :h WHERE id = :u",
            [':h' => $currentToken ? hash('sha256', $currentToken) : null, ':u' => $userId]);
    }

    private static function unauth(string $msg): Response
    {
        $res = new SlimResponse();
        return Http::json($res, ['message' => $msg], 401);
    }
}
