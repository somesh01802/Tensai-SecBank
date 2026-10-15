<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Rewards};

class NotificationController
{
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $rows = Db::all('SELECT * FROM notifications WHERE user_id = :u ORDER BY created_at DESC', [':u' => $u['id']]);
        $unread = count(array_filter($rows, fn($r) => $r['readAt'] === null));
        return Http::json($res, ['notifications' => $rows, 'unreadCount' => $unread]);
    }

    public function markRead(Request $req, Response $res, array $args): Response
    {
        $u = $req->getAttribute('user');
        $row = Db::one('UPDATE notifications SET read_at = now() WHERE id=:i AND user_id=:u RETURNING *',
            [':i' => $args['id'], ':u' => $u['id']]);
        if (!$row) throw new ApiError('Notification not found', 404);
        Rewards::award($u['id'], 'notification.read');
        $cnt = Db::one('SELECT COUNT(*) AS n FROM notifications WHERE user_id=:u AND read_at IS NOT NULL', [':u' => $u['id']]);
        if ((int) $cnt['n'] >= 5) Rewards::award($u['id'], 'notification.read.count.gte.5');
        return Http::json($res, ['notification' => $row]);
    }

    public function markAllRead(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        Db::run('UPDATE notifications SET read_at = now() WHERE user_id=:u AND read_at IS NULL', [':u' => $u['id']]);
        Rewards::award($u['id'], 'notification.all_read');
        return Http::json($res, ['message' => 'All notifications marked read']);
    }
}
