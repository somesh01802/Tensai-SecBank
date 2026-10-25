<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, Token, Mpin, Provision, ApiError, Apm, Audit};

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
        // Role is never taken from the request: registration always creates a CUSTOMER.
        // is_synthetic is derived server-side from reserved test-data email domains.
        $user = Db::one(
            'INSERT INTO users (email, name, password_hash, mobile_number, is_synthetic) VALUES (:e,:n,:h,:m,:s)
             RETURNING id, email, name, mobile_number, role, is_synthetic',
            [':e' => strtolower($email), ':n' => $name, ':h' => $hash, ':m' => $mobile,
             ':s' => self::isSyntheticEmail($email) ? 'true' : 'false']
        );

        try {
            Provision::forUser($user['id'], $user['name']);
        } catch (\Throwable $e) {
            error_log('[auth.register] provisioning failed: ' . $e->getMessage());
        }

        $token = Token::sign($user['id']);
        $eventId = $this->track($req, $user, 'register', 'password', 'success');
        $res = Http::json($res, ['user' => self::publicUser($user), 'token' => $token, 'needsMpin' => true,
            'loginEventId' => $eventId, 'userRef' => Apm::userRef($user['id'])], 201);
        return $this->withAuthCookie($res, $token);
    }

    public function login(Request $req, Response $res): Response
    {
        $b = (array) $req->getParsedBody();
        $email = $b['email'] ?? null; $mobile = $b['mobileNumber'] ?? null;
        $password = $b['password'] ?? null; $mpin = $b['mpin'] ?? null;
        $loginAs = strtolower((string) ($b['loginAs'] ?? 'customer'));

        if (!in_array($loginAs, ['customer', 'admin'], true)) throw new ApiError('loginAs must be "customer" or "admin"', 400);
        if (!$password && !$mpin) throw new ApiError('Provide password or MPIN', 400);
        if (!$email && !$mobile) throw new ApiError('Provide email or mobile number', 400);
        if ($loginAs === 'admin' && $mpin) throw new ApiError('Admin sign-in requires email and password', 400);
        Apm::label('login_as', $loginAs);

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

        // Separation of duties: admins only via the Admin sign-in, customers only via the Customer sign-in.
        $role = $user['role'] ?? 'CUSTOMER';
        if (($loginAs === 'admin') !== ($role === 'ADMIN')) {
            $this->track($req, $user, 'login', $method, 'failure');
            if ($loginAs === 'admin') Audit::log($req, $user['id'], 'admin.login_denied', 'user', $user['id'], ['reason' => 'not an admin']);
            throw new ApiError($loginAs === 'admin'
                ? 'This account is not authorized for admin access'
                : 'Admin accounts must use the Admin sign-in', 403);
        }

        $eventId = $this->track($req, $user, 'login', $method, 'success');
        if ($role === 'ADMIN') Audit::log($req, $user['id'], 'admin.login', 'user', $user['id']);
        $token = Token::sign($user['id']);
        $res = Http::json($res, [
            'user' => self::publicUser($user),
            'token' => $token,
            'hasMpin' => Mpin::has($user['id']),
            'loginEventId' => $eventId,
            'userRef' => Apm::userRef($user['id']),
        ]);
        return $this->withAuthCookie($res, $token);
    }

    private const LOCATION_STATUSES = ['granted', 'denied', 'dismissed', 'unavailable', 'timeout', 'error'];

    /**
     * POST /api/auth/location — the browser-geolocation outcome for one login.
     * Coordinates are stored ONLY when the user granted permission; every other
     * outcome is recorded honestly as its status with no coordinates. Nothing is
     * ever inferred from the IP address.
     */
    public function location(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $eventId = filter_var($b['loginEventId'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $status = $b['status'] ?? null;
        if (!$eventId) throw new ApiError('loginEventId is required', 400);
        if (!in_array($status, self::LOCATION_STATUSES, true))
            throw new ApiError('status must be one of: ' . implode(', ', self::LOCATION_STATUSES), 400);

        $lat = $lon = $acc = null;
        if ($status === 'granted') {
            $lat = $b['latitude'] ?? null; $lon = $b['longitude'] ?? null; $acc = $b['accuracy'] ?? null;
            if (!is_numeric($lat) || !is_numeric($lon) || abs((float) $lat) > 90 || abs((float) $lon) > 180)
                throw new ApiError('Valid latitude and longitude are required when permission is granted', 400);
            if ($acc !== null && (!is_numeric($acc) || (float) $acc < 0))
                throw new ApiError('accuracy must be a non-negative number of metres', 400);
        }

        $event = Db::one('SELECT id, session_id FROM login_events WHERE id = :i AND user_id = :u',
            [':i' => $eventId, ':u' => $u['id']]);
        if (!$event) throw new ApiError('Login event not found', 404);

        $n = Db::run(
            'INSERT INTO login_locations (login_event_id, user_id, session_id, status, latitude, longitude, accuracy_m)
             VALUES (:e,:u,:s,:st,:la,:lo,:ac) ON CONFLICT (login_event_id) DO NOTHING',
            [':e' => $eventId, ':u' => $u['id'], ':s' => $event['sessionId'], ':st' => $status,
             ':la' => $lat !== null ? round((float) $lat, 6) : null, ':lo' => $lon !== null ? round((float) $lon, 6) : null,
             ':ac' => $acc !== null ? round((float) $acc, 2) : null]
        );
        if ($n === 0) throw new ApiError('Location already recorded for this login', 409);

        Apm::name('POST /api/auth/location');
        Apm::label('location_status', $status);
        Apm::label('login_event_id', (int) $eventId);
        return Http::json($res, ['recorded' => true, 'status' => $status], 201);
    }

    private static function publicUser(array $u): array
    {
        return ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name'],
                'mobileNumber' => $u['mobileNumber'] ?? null, 'role' => $u['role'] ?? 'CUSTOMER'];
    }

    /** Reserved test-data domains (SYNTHETIC_EMAIL_DOMAINS, default tensai.test incl. sub-domains). */
    public static function isSyntheticEmail(string $email): bool
    {
        $domain = strtolower(substr(strrchr($email, '@') ?: '', 1));
        $list = $_ENV['SYNTHETIC_EMAIL_DOMAINS'] ?? getenv('SYNTHETIC_EMAIL_DOMAINS') ?: 'tensai.test';
        foreach (array_filter(array_map('trim', explode(',', strtolower($list)))) as $d)
            if ($domain === $d || str_ends_with($domain, '.' . $d)) return true;
        return false;
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
            'user' => self::publicUser($u),
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
     * because telemetry failed. Returns the login_events id (the key the
     * browser uses to attach the location outcome), or null if not recorded.
     */
    private function track(Request $req, array $user, string $event, string $method, string $outcome): ?int
    {
        $ip = $req->getHeaderLine('X-Forwarded-For')
            ?: ($req->getServerParams()['REMOTE_ADDR'] ?? null);
        $eventId = null;
        try {
            $row = Db::one(
                'INSERT INTO login_events (user_id, username, email, event, outcome, method, ip, session_id)
                 VALUES (:uid,:un,:em,:ev,:oc,:m,:ip,:sid) RETURNING id',
                [':uid' => $user['id'], ':un' => $user['name'], ':em' => $user['email'] ?? null,
                 ':ev' => $event, ':oc' => $outcome, ':m' => $method, ':ip' => $ip, ':sid' => Apm::sessionId($req)]
            );
            $eventId = (int) $row['id'];
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
        Apm::correlate($req, $user);
        if ($eventId) Apm::label('login_event_id', $eventId);
        return $eventId;
    }

    private function withAuthCookie(Response $res, string $token): Response
    {
        $secure = (($_ENV['NODE_ENV'] ?? '') === 'production') ? ' Secure;' : '';
        $maxAge = Token::ttlSeconds();
        $cookie = "token=$token; Path=/; HttpOnly; SameSite=Lax; Max-Age=$maxAge;$secure";
        return $res->withAddedHeader('Set-Cookie', $cookie);
    }
}
