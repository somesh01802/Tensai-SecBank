<?php
namespace Tensai;

use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Append-only audit trail in the existing `audit_logs` table (since 0002).
 * Used for administrative access. Best-effort: an audit write failure is
 * logged but never breaks the request.
 */
final class Audit
{
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    public static function log(?Request $req, ?string $actorId, string $event, ?string $entity = null, ?string $entityId = null, array $meta = []): void
    {
        try {
            Db::run(
                'INSERT INTO audit_logs (user_id, event_type, entity, entity_id, metadata, ip) VALUES (:u,:e,:n,:i,:m,:ip)',
                [':u' => $actorId, ':e' => $event, ':n' => $entity,
                 ':i' => ($entityId && preg_match(self::UUID, $entityId)) ? $entityId : null,
                 ':m' => json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
                 ':ip' => $req ? (($req->getServerParams()['REMOTE_ADDR'] ?? null)) : 'cli']
            );
        } catch (\Throwable $e) {
            error_log('[audit] ' . $e->getMessage());
        }
    }
}
