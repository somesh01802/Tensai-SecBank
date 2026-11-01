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
        $bearer = self::bearer($req);
        $token = $bearer ?? ($req->getCookieParams()['token'] ?? null);
        if (!$token) return self::unauth('Unauthorized: token is missing');

        // CSRF (VAPT-12): the browser authenticates with the cookie, so a state-changing request must also carry a
        // custom header that another origin cannot send without passing the CORS allow-list.
        if ($bearer === null && !in_array($req->getMethod(), ['GET', 'HEAD', 'OPTIONS'], true) && $req->getHeaderLine('X-Tensai-Client') === '')
            return Http::json(new SlimResponse(), ['message' => 'Forbidden: missing client header'], 403);

        $claims = Token::claims($token);
        if (!$claims) return self::unauth('Unauthorized: token is invalid');
        $userId = $claims['userId'];

        // Revoked (logged-out) tokens and sessions are rejected.
        $revoked = Db::one('SELECT 1 FROM revoked_tokens WHERE token = :t UNION ALL SELECT 1 FROM revoked_sessions WHERE sid = :s',
            [':t' => $token, ':s' => $claims['sid']]);
        if ($revoked) return self::unauth('Unauthorized: session ended');

        $user = Db::one(
            'SELECT id, email, name, mobile_number, is_system_user, role, is_synthetic,
                    floor(extract(epoch FROM sessions_valid_after) * 1000)::bigint AS valid_after, session_keep_hash
             FROM users WHERE id = :id',
            [':id' => $userId]
        );
        if (!$user) return self::unauth('Unauthorized: user not found');
        // VAPT-09: a password or MPIN change ends every older session except the one that made the change.
        if ($user['validAfter'] !== null && Token::issuedAtMs($token) <= (int) $user['validAfter']
            && !hash_equals((string) $user['sessionKeepHash'], hash('sha256', $claims['sid'])))
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

        $req = $req->withAttribute('user', $user)->withAttribute('token', $token)->withAttribute('sid', $claims['sid']);
        $res = $handler->handle($req);

        // Sliding session (VAPT-09): an active session gets a fresh 30-minute token every few minutes, as the cookie
        // for the browser and in X-Session-Token for API clients; idle sessions simply expire.
        if (time() - (int) $claims['iat'] >= Token::RENEW_AFTER && $res->getStatusCode() < 400) {
            $fresh = Token::sign($userId, $claims['sid'], (int) $claims['sst']);
            $res = $res->withHeader('X-Session-Token', $fresh);
            if ($bearer === null) $res = $res->withAddedHeader('Set-Cookie', self::cookie($req, $fresh));
        }
        return $res;
    }

    /** The session cookie: HttpOnly, SameSite=Strict, Secure whenever the request arrived over HTTPS (VAPT-12/17). */
    public static function cookie(Request $req, string $token): string
    {
        $sp = $req->getServerParams();
        $https = $req->getUri()->getScheme() === 'https' || strtolower((string) ($sp['HTTPS'] ?? '')) === 'on'
            || strtolower($req->getHeaderLine('X-Forwarded-Proto')) === 'https';
        return "token=$token; Path=/; HttpOnly; SameSite=Strict; Max-Age=" . Token::ttlSeconds() . ($https ? '; Secure' : '');
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
    public static function endOtherSessions(string $userId, ?string $currentSid): void
    {
        Db::run("UPDATE users SET sessions_valid_after = clock_timestamp(), session_keep_hash = :h WHERE id = :u",
            [':h' => $currentSid ? hash('sha256', $currentSid) : null, ':u' => $userId]);
    }

    private static function unauth(string $msg): Response
    {
        $res = new SlimResponse();
        return Http::json($res, ['message' => $msg], 401);
    }
}
