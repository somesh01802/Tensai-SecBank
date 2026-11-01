<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError};

class ProfileController
{
    private const EMAIL_RE = '/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/';

    public function get(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        return Http::json($res, ['profile' => ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name']]]);
    }

    public function update(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $sets = []; $params = [':id' => $u['id']];
        if (isset($b['name']) && is_string($b['name']) && trim($b['name']) !== '') { $sets[] = 'name = :n'; $params[':n'] = trim($b['name']); }
        if (isset($b['email']) && is_string($b['email']) && trim($b['email']) !== '') {
            if (!preg_match(self::EMAIL_RE, $b['email'])) throw new ApiError('Invalid email address', 400);
            $sets[] = 'email = :e'; $params[':e'] = strtolower($b['email']);
        }
        if (!$sets) throw new ApiError('No changes', 400);
        // VAPT-24: changing the sign-in email needs the MPIN (name changes do not).
        if (isset($params[':e']) && $params[':e'] !== strtolower((string) $u['email'])) \Tensai\Mpin::stepUp($req, $u);
        $sets[] = 'updated_at = now()';
        try {
            $row = Db::one('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = :id RETURNING id, email, name', $params);
        } catch (\PDOException $e) {
            if (str_contains($e->getMessage(), 'users_email_unique')) throw new ApiError('Email already in use', 409);
            throw $e;
        }
        \Tensai\Audit::log($req, $u['id'], 'profile.updated', 'user', $u['id'],
            ['fields' => array_values(array_intersect(['name', 'email'], array_keys($b))), 'emailChanged' => isset($params[':e']) && $params[':e'] !== $u['email']]);
        return Http::json($res, ['profile' => $row]);
    }

    public function changePassword(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $cur = $b['currentPassword'] ?? null; $new = $b['newPassword'] ?? null;
        if (!$cur || !$new) throw new ApiError('currentPassword and newPassword are required', 400);
        if ($p = \Tensai\Passwords::problem($new)) throw new ApiError($p, 400);   // VAPT-11
        $row = Db::one('SELECT id, password_hash FROM users WHERE id = :id', [':id' => $u['id']]);
        if (!$row) throw new ApiError('User not found', 404);
        if (!password_verify($cur, $row['passwordHash'])) throw new ApiError('Current password is incorrect', 401);
        Db::run('UPDATE users SET password_hash = :h, updated_at = now() WHERE id = :id', [':h' => \Tensai\Passwords::hash($new), ':id' => $u['id']]);
        \Tensai\Auth::endOtherSessions($u['id'], $req->getAttribute('sid'));   // VAPT-09: other sessions end here
        \Tensai\Audit::log($req, $u['id'], 'auth.password_changed', 'user', $u['id']);
        return Http::json($res, ['message' => 'Password changed']);
    }
}
