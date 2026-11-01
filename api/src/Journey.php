<?php
namespace Tensai;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\RequestHandlerInterface as Handler;
use Psr\Http\Message\ResponseInterface as Response;

/**
 * Business-journey telemetry (dashboards D0-D4). Outer middleware: after the
 * response is final (errors included) it writes one `journey_events` row for
 * every instrumented route below. The browser groups the steps of one attempt
 * with an X-Journey-Id header; intermediate UI-only steps arrive via
 * POST /api/journey/step (JourneyController). Recording is best-effort and can
 * never change a response.
 */
final class Journey implements \Psr\Http\Server\MiddlewareInterface
{
    /** [method, path regex, journey, steps emitted on success (last one completes the journey when final)] */
    private const ROUTES = [
        ['POST', '#^/api/auth/login$#', 'login', ['sign_in']],
        ['POST', '#^/api/auth/register$#', 'onboarding', ['register']],
        ['POST', '#^/api/account-applications$#', 'onboarding', ['open_account']],
        ['GET', '#^/api/dashboard/summary$#', 'view_accounts', ['load_accounts']],
        ['POST', '#^/api/bills/[^/]+/pay$#', 'bill_pay', ['confirm_payment', 'receipt']],
        ['POST', '#^/api/(autopay|recurring-bills)$#', 'autopay_setup', ['confirm_autopay']],
        ['POST', '#^/api/transfer/quick$#', 'p2p_transfer', ['confirm_transfer']],
        ['POST', '#^/api/cards/[^/]+/pay$#', 'card_payment', ['authorize']],
        ['POST', '#^/api/cards/[^/]+/freeze$#', 'card_controls', ['change_control']],
        ['POST', '#^/api/loans/apply$#', 'loan_apply', ['submit_application']],
        ['POST', '#^/api/disputes$#', 'dispute', ['submit_dispute']],
    ];
    public const CHANNELS = ['web', 'mobile_web', 'branch', 'atm', 'partner_api'];
    /** Technical reason codes (spec vocabulary) for infrastructure failures. */
    private const TECHNICAL = ['processor_timeout' => 'gateway_timeout', 'network_failure' => 'gateway_timeout',
        'service_outage' => 'gateway_timeout', 'internal_error' => 'gateway_timeout', 'db_concurrency' => 'gateway_timeout',
        'fraud_timeout' => 'fraud_hold'];

    /** Request-scoped context filled by Auth / AuthController / Attempts. */
    public static ?array $user = null;
    public static array $ctx = [];

    public function process(Request $req, Handler $h): Response
    {
        self::$user = null; self::$ctx = [];
        $t0 = hrtime(true);
        $res = $h->handle($req);
        $route = self::match($req);
        if ($route && self::$user) {
            try {
                self::emit($req, $route[2], $route[3], $res->getStatusCode(), (int) round((hrtime(true) - $t0) / 1e6));
            } catch (\Throwable $e) {
                error_log('[journey] ' . $e->getMessage());
            }
        }
        return $res;
    }

    private static function match(Request $req): ?array
    {
        foreach (self::ROUTES as $r)
            if ($req->getMethod() === $r[0] && preg_match($r[1], $req->getUri()->getPath())) return $r;
        return null;
    }

    private static function emit(Request $req, string $journey, array $steps, int $status, int $ms): void
    {
        $ok = $status < 400;
        $cat = self::$ctx['category'] ?? null;
        foreach ($ok ? $steps : [$steps[0]] as $step) {
            self::record($req, $journey, $step, $ok ? null : self::reason($status, $cat), $status, $ms);
        }
    }

    /** [reason_code, failure_class] for a failed step. */
    public static function reason(int $status, ?string $category): array
    {
        if ($status === 401) return ['invalid_credentials', 'user'];
        if ($category === 'insufficient_funds') return ['insufficient_funds', 'business'];
        if (isset(self::TECHNICAL[$category])) return [self::TECHNICAL[$category], 'technical'];
        if ($status >= 500) return ['gateway_timeout', 'technical'];
        return [$category ?: 'validation_error', in_array($category, ['transfer_limit', 'forbidden'], true) ? 'business' : 'user'];
    }

    /** Write one step event. $fail = [reason_code, failure_class] or null on success. */
    public static function record(Request $req, string $journey, string $step, ?array $fail, ?int $status, ?int $ms): void
    {
        $u = self::$user;
        $jid = Attempts::isUuid($req->getHeaderLine('X-Journey-Id')) ? strtolower($req->getHeaderLine('X-Journey-Id'))
            : (self::$ctx['journeyId'] ??= self::uuid());
        $def = Db::one('SELECT step_index, is_final FROM bank_journey_steps WHERE journey = :j AND step = :s',
            [':j' => $journey, ':s' => $step]);
        if (!$def) return;
        $first = Db::one('SELECT min(created_at) AS t FROM journey_events WHERE journey_id = :id', [':id' => $jid]);
        $started = $first['t'] ?? null;
        $status_ = $fail ? 'failed' : ($def['isFinal'] ? 'completed' : ($started ? null : 'started'));
        [$device, $browser] = self::agent($req->getHeaderLine('User-Agent'));
        Db::run(
            'INSERT INTO journey_events (journey_id, journey, step, step_index, status, outcome, reason_code, failure_class,
                amount, channel, device, browser, user_id, session_id, attempt_id, trace_id, http_status, duration_ms,
                journey_duration_ms, is_synthetic)
             VALUES (:jid,:j,:s,:si,:st,:o,:rc,:fc,:a,:ch,:dv,:br,:u,:sid,:att,:tr,:hs,:ms,
                CASE WHEN CAST(:done AS boolean) THEN (EXTRACT(EPOCH FROM now() - COALESCE(CAST(:t0 AS timestamptz), now())) * 1000)::bigint END,
                (SELECT is_synthetic FROM users WHERE id = :u2))',
            [':jid' => $jid, ':j' => $journey, ':s' => $step, ':si' => $def['stepIndex'], ':st' => $status_,
             ':o' => $fail ? 'failure' : 'success', ':rc' => $fail[0] ?? null, ':fc' => $fail[1] ?? null,
             ':a' => self::$ctx['amount'] ?? null, ':ch' => self::channel($req, $device), ':dv' => $device, ':br' => $browser,
             ':u' => $u['id'], ':u2' => $u['id'], ':sid' => Apm::sessionId($req), ':att' => self::$ctx['attemptId'] ?? null,
             ':tr' => Apm::traceId(), ':hs' => $status, ':ms' => $ms,
             ':done' => ($status_ === 'completed' || $status_ === 'failed') ? 'true' : 'false', ':t0' => $started]
        );
        Apm::label('journey_name', $journey);
        Apm::label('journey_id', $jid);
    }

    /** Explicit channel header (branch/atm/partner simulators) or mobile_web/web from the user agent. */
    private static function channel(Request $req, string $device): string
    {
        $c = strtolower($req->getHeaderLine('X-Channel'));
        return in_array($c, self::CHANNELS, true) ? $c : ($device === 'mobile' ? 'mobile_web' : 'web');
    }

    /** [device, browser] from a user agent: coarse on purpose, no fingerprinting. */
    public static function agent(string $ua): array
    {
        $device = preg_match('/Mobi|Android|iPhone|iPad/i', $ua) ? 'mobile' : 'desktop';
        $browser = match (true) {
            str_contains($ua, 'Edg/') => 'Edge',
            str_contains($ua, 'Firefox/') => 'Firefox',
            str_contains($ua, 'Chrome/') => 'Chrome',
            str_contains($ua, 'Safari/') => 'Safari',
            $ua === '' => null,
            default => 'Other',
        };
        return [$device, $browser];
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
