<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Http, ApiError, Rewards};

class RewardsController
{
    public function list(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        return Http::json($res, Rewards::list($u['id']));
    }

    public function event(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $cond = ((array) $req->getParsedBody())['condition'] ?? null;
        if (!$cond || !is_string($cond)) throw new ApiError('condition required', 400);
        $r = Rewards::award($u['id'], $cond);
        return Http::json($res, [
            'awarded' => $r !== null,
            'task' => $r ? ['code' => $r['task']['code'], 'title' => $r['task']['title'], 'points' => $r['task']['points']] : null,
        ]);
    }
}
