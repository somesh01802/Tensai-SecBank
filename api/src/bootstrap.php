<?php
namespace Tensai;

use Slim\Factory\AppFactory;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Server\RequestHandlerInterface as Handler;

require __DIR__ . '/../vendor/autoload.php';

// --- env ---
if (is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}

function app(): \Slim\App
{
    $app = AppFactory::create();
    $app->addBodyParsingMiddleware();
    $app->addRoutingMiddleware();

    // Error handler -> always { message } JSON, matching the old API contract.
    $errMw = $app->addErrorMiddleware(false, true, true);
    $errMw->setDefaultErrorHandler(function (Request $req, \Throwable $e) use ($app): Response {
        $res = $app->getResponseFactory()->createResponse();
        if ($e instanceof ApiError) {
            // Business failure (bad login, insufficient balance, invalid account…):
            // mark the APM transaction failed so it shows in Kibana's failure rate.
            Apm::failure($e);
            $body = array_merge(['message' => $e->getMessage()], $e->extra ?? []);
            return Http::json($res, $body, $e->status);
        }
        if ($e instanceof \Slim\Exception\HttpNotFoundException) {
            return Http::json($res, ['message' => 'Not found'], 404);
        }
        if ($e instanceof \Slim\Exception\HttpMethodNotAllowedException) {
            return Http::json($res, ['message' => 'Method not allowed'], 405);
        }
        error_log('[api] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        Apm::error($e); // surface unexpected 500s under Kibana APM → Errors
        return Http::json($res, ['message' => 'Internal server error'], 500);
    });

    // CORS — added LAST so it is the outermost middleware: preflights and
    // error responses (401/400/404 built by the error handler above) also get
    // the headers. Reflects an allowed origin and allows credentials.
    $origins = array_map('trim', explode(',', $_ENV['CORS_ORIGIN'] ?? 'http://localhost:5173,http://localhost:8088'));
    $app->add(function (Request $req, Handler $h) use ($origins): Response {
        $origin = $req->getHeaderLine('Origin');
        $allow = in_array($origin, $origins, true) ? $origin : ($origins[0] ?? '*');
        $res = $req->getMethod() === 'OPTIONS'
            ? (new \Slim\Psr7\Response())->withStatus(204)
            : $h->handle($req);
        return $res
            ->withHeader('Access-Control-Allow-Origin', $allow)
            ->withHeader('Access-Control-Allow-Credentials', 'true')
            // traceparent/tracestate/elastic-apm-traceparent let the browser RUM
            // agent correlate its transaction with the PHP backend (distributed tracing).
            // X-Session-Id: login-session correlation. X-Tensai-Fault: synthetic-only fault injection (ignored for real users).
            ->withHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, traceparent, tracestate, elastic-apm-traceparent, X-Session-Id, X-Tensai-Fault')
            ->withHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
            ->withHeader('Access-Control-Max-Age', '600')
            ->withAddedHeader('Vary', 'Origin');
    });

    (require __DIR__ . '/routes.php')($app);
    return $app;
}
