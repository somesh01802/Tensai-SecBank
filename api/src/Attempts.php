<?php
namespace Tensai;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;

/**
 * Wraps every money movement (P2P, external transfer, bill payment) so each
 * ATTEMPT — successful or failed — is recorded in `transaction_attempts`,
 * labelled on the APM transaction, and returned to the client as `attemptId`
 * (the key for post-transaction feedback). Recording is best-effort: it can
 * never change the outcome the customer receives.
 *
 * Also enforces the per-transaction transfer limit and hosts fault injection,
 * which only ever fires for synthetic (test) users when
 * FAULT_INJECTION_ENABLED=true — and always BEFORE the ledger is touched, so
 * an injected failure never moves money.
 */
final class Attempts
{
    /** Injectable faults: [HTTP status, customer-facing message, simulated latency ms]. */
    public const FAULTS = [
        'processor_timeout' => [504, 'The payment processor timed out. No money was moved.', 1500],
        'network_failure'   => [502, 'A network error interrupted the payment. No money was moved.', 300],
        'fraud_timeout'     => [504, 'Fraud screening timed out. No money was moved.', 1200],
        'db_concurrency'    => [409, 'The payment conflicted with a concurrent update. No money was moved, please retry.', 50],
        'service_outage'    => [503, 'Payments are temporarily unavailable. No money was moved.', 0],
    ];
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /**
     * @param array    $meta amount, category, sourceAccountId, target, idempotencyKey (the closure may fill more)
     * @param callable $fn   function (array &$meta): array{0: array $payload, 1: int $httpStatus, 2: ?string $transactionId}
     */
    public static function run(Request $req, Response $res, array $user, string $kind, array $meta, callable $fn): Response
    {
        $id = self::uuid();
        $t0 = hrtime(true);
        $synthetic = (bool) ($user['isSynthetic'] ?? false);
        Apm::label('attempt_id', $id);
        Apm::label('txn_kind', $kind);

        $fault = null;
        try {
            self::checkLimit($kind, $meta['amount'] ?? null);
            $fault = self::injectedFault($req, $synthetic);
            if ($fault) {
                [$status, $message, $latencyMs] = self::FAULTS[$fault];
                if ($latencyMs) usleep($latencyMs * 1000);
                throw new ApiError($message, $status);
            }
            [$payload, $status, $txId] = $fn($meta);
        } catch (ApiError $e) {
            $cat = $fault ?? self::classify($e);
            self::record($id, $req, $user, $kind, $meta, 'FAILURE', $cat, $e->getMessage(), $e->status, null, $t0, $fault !== null);
            throw new ApiError($e->getMessage(), $e->status,
                array_merge($e->extra ?? [], ['attemptId' => $id, 'errorCategory' => $cat]));
        } catch (\Throwable $e) {
            $concurrency = self::isConcurrency($e);
            $cat = $concurrency ? 'db_concurrency' : 'internal_error';
            error_log("[attempt $id] " . get_class($e) . ': ' . $e->getMessage());
            Apm::error($e);
            $status = $concurrency ? 409 : 500;
            $message = $concurrency ? self::FAULTS['db_concurrency'][1] : 'Internal server error';
            self::record($id, $req, $user, $kind, $meta, 'FAILURE', $cat, $message, $status, null, $t0, false);
            throw new ApiError($message, $status, ['attemptId' => $id, 'errorCategory' => $cat]);
        }

        self::record($id, $req, $user, $kind, $meta, 'SUCCESS', null, null, $status, $txId, $t0, false);
        return Http::json($res, $payload + ['attemptId' => $id], $status);
    }

    public static function isUuid(?string $s): bool
    {
        return is_string($s) && preg_match(self::UUID, $s) === 1;
    }

    /** "••••1234" — enough to recognise an account, never the full number. */
    public static function mask(?string $s): string
    {
        return $s ? '••••' . substr($s, -4) : '';
    }

    public static function transferLimit(): float
    {
        return (float) ($_ENV['TRANSFER_LIMIT_PER_TXN'] ?? getenv('TRANSFER_LIMIT_PER_TXN') ?: 500000);
    }

    private static function checkLimit(string $kind, $amount): void
    {
        if ($kind === 'BILL' || !is_numeric($amount)) return;
        $limit = self::transferLimit();
        if ((float) $amount > $limit)
            throw new ApiError('Transfer limit exceeded: the maximum is ' . number_format($limit, 2) . ' per transaction', 400,
                ['limit' => $limit]);
    }

    private static function injectedFault(Request $req, bool $synthetic): ?string
    {
        $enabled = filter_var($_ENV['FAULT_INJECTION_ENABLED'] ?? getenv('FAULT_INJECTION_ENABLED') ?: 'false', FILTER_VALIDATE_BOOLEAN);
        $fault = $req->getHeaderLine('X-Tensai-Fault');
        // Real customers can never trigger a fault: the flag comes from the users row, not the request.
        return ($enabled && $synthetic && isset(self::FAULTS[$fault])) ? $fault : null;
    }

    /** Map an ApiError to a stable failure category for dashboards. */
    public static function classify(ApiError $e): string
    {
        $m = strtolower($e->getMessage());
        return match (true) {
            str_contains($m, 'insufficient') => 'insufficient_funds',
            str_contains($m, 'limit') => 'transfer_limit',
            $e->status === 409 => 'duplicate_request',
            $e->status === 403 => 'forbidden',
            str_contains($m, 'source account') => 'invalid_account',
            $e->status === 404, str_contains($m, 'account'), str_contains($m, 'bank'), str_contains($m, 'beneficiar') => 'invalid_beneficiary',
            $e->status >= 500 => 'internal_error',
            default => 'validation_error',
        };
    }

    private static function isConcurrency(\Throwable $e): bool
    {
        // 40001 serialization_failure, 40P01 deadlock_detected, 55P03 lock_not_available
        return $e instanceof \PDOException && in_array((string) $e->getCode(), ['40001', '40P01', '55P03'], true);
    }

    private static function record(string $id, Request $req, array $user, string $kind, array $meta, string $outcome,
                                   ?string $cat, ?string $message, int $status, ?string $txId, int $t0, bool $fault): void
    {
        $ms = (int) round((hrtime(true) - $t0) / 1e6);
        $amount = $meta['amount'] ?? null;
        $amount = (is_numeric($amount) && is_finite((float) $amount) && abs((float) $amount) < 1e15) ? number_format((float) $amount, 2, '.', '') : null;
        Apm::label('txn_outcome', strtolower($outcome));
        Apm::label('error_category', $cat);
        try {
            Db::run(
                'INSERT INTO transaction_attempts (id, user_id, session_id, kind, category, amount, source_account_id, target,
                    transaction_id, outcome, error_category, error_message, http_status, duration_ms, trace_id, idempotency_key,
                    is_synthetic, fault_injected)
                 VALUES (:id,:u,:s,:k,:c,:a,:src,:tg,:tx,:o,:ec,:em,:hs,:d,:tr,:ik,:syn,:f)',
                [':id' => $id, ':u' => $user['id'], ':s' => Apm::sessionId($req), ':k' => $kind,
                 ':c' => $meta['category'] ?? null, ':a' => $amount,
                 ':src' => self::isUuid($meta['sourceAccountId'] ?? null) ? $meta['sourceAccountId'] : null,
                 ':tg' => isset($meta['target']) ? substr((string) $meta['target'], 0, 120) : null,
                 ':tx' => $txId, ':o' => $outcome, ':ec' => $cat,
                 ':em' => $message !== null ? substr($message, 0, 300) : null, ':hs' => $status, ':d' => $ms,
                 ':tr' => Apm::traceId(), ':ik' => isset($meta['idempotencyKey']) ? substr((string) $meta['idempotencyKey'], 0, 200) : null,
                 ':syn' => (bool) ($user['isSynthetic'] ?? false) ? 'true' : 'false', ':f' => $fault ? 'true' : 'false']
            );
        } catch (\Throwable $e) {
            error_log("[attempt $id] record failed: " . $e->getMessage()); // never changes the outcome
        }
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
