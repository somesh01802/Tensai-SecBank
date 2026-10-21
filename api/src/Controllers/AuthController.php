<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, Token, Mpin, Provision, ApiError, Apm};

class AuthController
{
    private const EMAIL_RE = '/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/';
    private const MOBILE_RE = '/^[0-9]{10}$/';

    public function register(Request $req, Response $res): Response
    {
        $b = (array) $req->getParsedBody();
        $email = $b['email'] ?? null; $password = $b['password'] ?? null;
        $name = $b['name'] ?? null; $mobile = $b['mobileNumber'] ?? null;

        if (!$email || !$password || !$name || !$mobile)
            throw new ApiError('name, email, password and mobileNumber are required', 400);
        if (!preg_match(self::EMAIL_RE, $email)) throw new ApiError('Invalid email address', 400);
        if (!preg_match(self::MOBILE_RE, $mobile)) throw new ApiError('Mobile number must be exactly 10 digits', 400);
        if (strlen($password) < 6) throw new ApiError('Password must be at least 6 characters', 400);

        $existing = Db::one(
            'SELECT id, email, mobile_number FROM users WHERE email = :e OR mobile_number = :m LIMIT 1',
            [':e' => strtolower($email), ':m' => $mobile]
        );
        if ($existing) {
            $reason = $existing['email'] === strtolower($email) ? 'email' : 'mobile number';
            throw new ApiError("A user with this $reason already exists", 422);
        }

        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
        $user = Db::one(
            'INSERT INTO users (email, name, password_hash, mobile_number) VALUES (:e,:n,:h,:m)
             RETURNING id, email, name, mobile_number',
            [':e' => strtolower($email), ':n' => $name, ':h' => $hash, ':m' => $mobile]
        );

        try {
            Provision::forUser($user['id'], $user['name']);
        } catch (\Throwable $e) {
            error_log('[auth.register] provisioning failed: ' . $e->getMessage());
        }

        $token = Token::sign($user['id']);
        $this->track($req, $user, 'register', 'password', 'success');
        $res = Http::json($res, ['user' => $user, 'token' => $token, 'needsMpin' => true], 201);
        return $this->withAuthCookie($res, $token);
    }

    public function login(Request $req, Response $res): Response
    {
        $b = (array) $req->getParsedBody();
        $email = $b['email'] ?? null; $mobile = $b['mobileNumber'] ?? null;
        $password = $b['password'] ?? null; $mpin = $b['mpin'] ?? null;

        if (!$password && !$mpin) throw new ApiError('Provide password or MPIN', 400);
        if (!$email && !$mobile) throw new ApiError('Provide email or mobile number', 400);

        $user = Db::one(
            'SELECT * FROM users WHERE email = :e OR mobile_number = :m LIMIT 1',
            [':e' => $email ? strtolower($email) : '___never___', ':m' => $mobile ?: '___never___']
        );
        if (!$user) throw new ApiError('Credentials are invalid', 401);

        $method = $mpin ? 'mpin' : 'password';
        if ($mpin) {
            $v = Mpin::verify($user['id'], $mpin);
            if (!$v['ok']) {
                $this->track($req, $user, 'login', $method, 'failure');
                throw new ApiError($v['message'], 401, isset($v['attemptsRemaining']) ? ['attemptsRemaining' => $v['attemptsRemaining']] : null);
            }
        } else {
            if (!password_verify($password, $user['passwordHash'])) {
                $this->track($req, $user, 'login', $method, 'failure');
                throw new ApiError('Credentials are invalid', 401);
            }
        }

        $this->track($req, $user, 'login', $method, 'success');
        $token = Token::sign($user['id']);
        $res = Http::json($res, [
            'user' => ['id' => $user['id'], 'email' => $user['email'], 'name' => $user['name'], 'mobileNumber' => $user['mobileNumber']],
            'token' => $token,
            'hasMpin' => Mpin::has($user['id']),
        ]);
        return $this->withAuthCookie($res, $token);
    }

    public function logout(Request $req, Response $res): Response
    {
        $token = \Tensai\Auth::bearer($req) ?? ($req->getCookieParams()['token'] ?? null);
        if ($token) {
            $expires = date('c', time() + Token::ttlSeconds());
            try {
                Db::run('INSERT INTO revoked_tokens (token, expires_at) VALUES (:t,:e) ON CONFLICT DO NOTHING',
                    [':t' => $token, ':e' => $expires]);
            } catch (\Throwable $e) { /* ignore */ }
        }
        return Http::json($res, ['message' => 'User logged out successfully'])
            ->withHeader('Set-Cookie', 'token=; Path=/; Max-Age=0');
    }

    public function me(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        if (!$u) throw new ApiError('Unauthorized', 401);
        return Http::json($res, [
            'user' => ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name'], 'mobileNumber' => $u['mobileNumber']],
            'hasMpin' => Mpin::has($u['id']),
        ]);
    }

    public function setMpin(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $mpin = ((array) $req->getParsedBody())['mpin'] ?? null;
        $r = Mpin::set($u['id'], $mpin);
        if (!$r['ok']) throw new ApiError($r['message'], 400);
        return Http::json($res, ['message' => 'MPIN saved']);
    }

    public function hasMpin(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        return Http::json($res, ['hasMpin' => Mpin::has($u['id'])]);
    }

    /**
     * Persist a login/register event and mirror it to Elastic APM so Kibana
     * shows the username, the running login count, and the timestamp for every
     * attempt (success or failure). DB write is best-effort — auth never fails
     * because telemetry failed.
     */
    private function track(Request $req, array $user, string $event, string $method, string $outcome): void
    {
        $ip = $req->getHeaderLine('X-Forwarded-For')
            ?: ($req->getServerParams()['REMOTE_ADDR'] ?? null);
        try {
            Db::run(
                'INSERT INTO login_events (user_id, username, email, event, outcome, method, ip)
                 VALUES (:uid,:un,:em,:ev,:oc,:m,:ip)',
                [':uid' => $user['id'], ':un' => $user['name'], ':em' => $user['email'] ?? null,
                 ':ev' => $event, ':oc' => $outcome, ':m' => $method, ':ip' => $ip]
            );
        } catch (\Throwable $e) {
            error_log('[auth.track] ' . $e->getMessage());
        }

        $count = 0;
        try {
            $row = Db::one(
                "SELECT count(*) AS c FROM login_events
                 WHERE user_id = :uid AND event = 'login' AND outcome = 'success'",
                [':uid' => $user['id']]
            );
            $count = (int) ($row['c'] ?? 0);
        } catch (\Throwable $e) { /* ignore */ }

        Apm::setUser($user['id'], $user['name'], $user['email'] ?? null);
        Apm::name('POST /api/auth/' . $event);
        Apm::label('auth.event', $event);
        Apm::label('auth.method', $method);
        Apm::label('auth.outcome', $outcome);
        Apm::label('auth.login_count', $count);
    }

    private function withAuthCookie(Response $res, string $token): Response
    {
        $secure = (($_ENV['NODE_ENV'] ?? '') === 'production') ? ' Secure;' : '';
        $maxAge = Token::ttlSeconds();
        $cookie = "token=$token; Path=/; HttpOnly; SameSite=Lax; Max-Age=$maxAge;$secure";
        return $res->withAddedHeader('Set-Cookie', $cookie);
    }
}
