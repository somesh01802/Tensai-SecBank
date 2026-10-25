<?php
namespace Tensai\Controllers;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface as Response;
use Tensai\{Db, Http, ApiError, Apm, Attempts};

/**
 * POST /api/feedback — Happy / Satisfied / Not satisfied (+ optional comment)
 * or a dismissal, for one transaction attempt (successful or failed).
 * Separate request from the transaction itself, so a feedback failure can
 * never change a transaction outcome. One response per attempt (unique key).
 */
class FeedbackController
{
    private const RATINGS = ['HAPPY', 'SATISFIED', 'NOT_SATISFIED'];

    public function submit(Request $req, Response $res): Response
    {
        $u = $req->getAttribute('user');
        $b = (array) $req->getParsedBody();
        $attemptId = $b['attemptId'] ?? null;
        $dismissed = filter_var($b['dismissed'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $rating = $dismissed ? null : strtoupper((string) ($b['rating'] ?? ''));
        $comment = $dismissed ? null : trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) ($b['comment'] ?? '')));

        if (!Attempts::isUuid($attemptId)) throw new ApiError('attemptId is required', 400);
        if (!$dismissed && !in_array($rating, self::RATINGS, true))
            throw new ApiError('rating must be one of: ' . implode(', ', self::RATINGS) . ' (or dismissed: true)', 400);
        if ($comment !== null && mb_strlen($comment) > 500) throw new ApiError('comment must be at most 500 characters', 400);

        $attempt = Db::one('SELECT id, outcome, transaction_id FROM transaction_attempts WHERE id = :a AND user_id = :u',
            [':a' => $attemptId, ':u' => $u['id']]);
        if (!$attempt) throw new ApiError('Transaction attempt not found', 404);

        $row = Db::one(
            'INSERT INTO transaction_feedback (attempt_id, user_id, status, rating, comment)
             VALUES (:a,:u,:s,:r,:c) ON CONFLICT (attempt_id) DO NOTHING RETURNING id, status, rating, created_at',
            [':a' => $attemptId, ':u' => $u['id'], ':s' => $dismissed ? 'DISMISSED' : 'SUBMITTED',
             ':r' => $rating, ':c' => $comment === '' ? null : $comment]
        );
        if (!$row) throw new ApiError('Feedback was already recorded for this transaction', 409);

        Apm::name('POST /api/feedback');
        Apm::label('attempt_id', $attemptId);
        Apm::label('feedback_status', $row['status']);
        Apm::label('feedback_rating', $rating);
        Apm::label('txn_outcome', strtolower($attempt['outcome']));
        return Http::json($res, ['feedback' => ['id' => (int) $row['id'], 'attemptId' => $attemptId,
            'status' => $row['status'], 'rating' => $row['rating'], 'createdAt' => $row['createdAt']]], 201);
    }
}
