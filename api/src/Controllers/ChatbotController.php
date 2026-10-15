<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Http, Chatbot};

class ChatbotController
{
    /** Per-user in-memory rate limit: 30 requests / 60s (single-instance demo). */
    // ponytail: static resets per PHP-FPM request so this is best-effort only; add APCu/Redis if real throttling matters.
    private static array $buckets = [];

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

    private static function rateLimited(string $key): bool
    {
        $now = microtime(true) * 1000;
        $b = self::$buckets[$key] ?? null;
        if (!$b || $now - $b['start'] > 60000) $b = ['start' => $now, 'count' => 0];
        if ($b['count'] >= 30) { self::$buckets[$key] = $b; return true; }
        $b['count']++;
        self::$buckets[$key] = $b;
        return false;
    }
}
