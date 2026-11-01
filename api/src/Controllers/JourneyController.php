<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Attempts, Journey};

/**
 * POST /api/journey/step  { journeyId, journey, step, cancelled? }
 * UI-only funnel steps (choose biller, enter amount, ...). Final steps are
 * rejected: completions are only ever recorded by the server route that did
 * the work, so a client cannot fake a successful journey.
 */
class JourneyController
{
    public function step(Request $req, Response $res): Response
    {
        $b = (array) $req->getParsedBody();
        $jid = $b['journeyId'] ?? null;
        if (!Attempts::isUuid($jid)) throw new ApiError('journeyId must be a UUID', 400);
        $def = Db::one('SELECT is_final FROM bank_journey_steps WHERE journey = :j AND step = :s',
            [':j' => (string) ($b['journey'] ?? ''), ':s' => (string) ($b['step'] ?? '')]);
        if (!$def) throw new ApiError('Unknown journey step', 400);
        if ($def['isFinal']) throw new ApiError('Final steps are recorded by the server', 400);

        $cancelled = filter_var($b['cancelled'] ?? false, FILTER_VALIDATE_BOOLEAN);
        Journey::record($req->withHeader('X-Journey-Id', $jid), $b['journey'], $b['step'],
            $cancelled ? ['user_cancel', 'user'] : null, null, null);
        return Http::json($res, ['recorded' => true], 201);
    }
}
