<?php
namespace Tensai;

use Psr\Http\Message\ResponseInterface as Response;

/** JSON response helpers + a typed API error that controllers can throw. */
class Http
{
    public static function json(Response $res, $data, int $status = 200): Response
    {
        $res->getBody()->write(json_encode($data, JSON_UNESCAPED_SLASHES));
        return $res->withHeader('Content-Type', 'application/json')->withStatus($status);
    }

    /** Numeric DB strings -> floats, for the fields the old API returned as numbers. */
    public static function num($v): float
    {
        return (float) $v;
    }
}

