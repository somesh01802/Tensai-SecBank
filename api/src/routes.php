<?php
namespace Tensai;

use Slim\App;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\Controllers\AuthController;

/**
 * Route table. Mirrors the Node mount points:
 *   /api/auth, /api/accounts, /api/transactions, /api/beneficiaries,
 *   /api/profile, /api/dashboard, /api/investments, /api/cards, /api/bills,
 *   /api/chatbot, plus the v2 routes mounted flat under /api.
 */
return function (App $app): void {
    $auth = new Auth();

    $app->get('/health', fn(Request $q, Response $r) => Http::json($r, ['status' => 'ok', 'service' => 'tensai-secbank']));

    $app->group('/api', function ($g) use ($auth) {
        $ac = new AuthController();

        // ---- auth ----
        $g->post('/auth/register', [$ac, 'register']);
        $g->post('/auth/login', [$ac, 'login']);
        $g->post('/auth/logout', [$ac, 'logout']);
        $g->get('/auth/me', [$ac, 'me'])->add($auth);
        $g->get('/auth/mpin', [$ac, 'hasMpin'])->add($auth);
        $g->post('/auth/mpin', [$ac, 'setMpin'])->add($auth);
    });
};
