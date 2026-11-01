<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, Chatbot};

class ChatbotController
{
    /** Per-user rate limit: 30 requests / 60 s, counted in PostgreSQL so every php-fpm worker shares it (VAPT-15). */
    public function ask(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        if (self::rateLimited($u['id']))
            return Http::json($res, ['message' => 'Too many chatbot requests. Please slow down.'], 429);

        $b = (array) $req->getParsedBody();
        try {
            $out = Chatbot::ask($u['id'], $b['message'] ?? null, $b['history'] ?? []);
            return Http::json($res, ['reply' => $out['text'], 'source' => $out['source']]);
        } catch (\Throwable $e) {
            error_log('[chatbot.ask] failed: ' . $e->getMessage());
            return Http::json($res, ['message' => 'The assistant is temporarily unavailable. Please try again.'], 500);
        }
    }

    private static function rateLimited(string $userId): bool
    {
        // One atomic upsert: a new 60 s window starts when the previous one has expired.
        $row = Db::one("INSERT INTO rate_limits (key, window_start, hits) VALUES (:k, now(), 1)
            ON CONFLICT (key) DO UPDATE SET
              hits = CASE WHEN rate_limits.window_start < now() - interval '60 seconds' THEN 1 ELSE rate_limits.hits + 1 END,
              window_start = CASE WHEN rate_limits.window_start < now() - interval '60 seconds' THEN now() ELSE rate_limits.window_start END
            RETURNING hits", [':k' => 'chatbot:' . $userId]);
        return (int) $row['hits'] > 30;
    }
}
