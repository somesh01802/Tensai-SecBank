<?php
namespace Tensai;

/** Reward awarding + listing — mirrors rewards.service (idempotent via unique index, milestone cascade). */
class Rewards
{
    /** Award the task matching $condition to a user, once. Returns ['task'=>..] or null. */
    public static function award(string $userId, string $condition): ?array
    {
        $task = Db::one('SELECT * FROM reward_tasks WHERE completion_condition = :c LIMIT 1', [':c' => $condition]);
        if (!$task) return null;
        try {
            $n = Db::run(
                'INSERT INTO user_reward_tasks (user_id, task_id, points_awarded) VALUES (:u,:t,:p)
                 ON CONFLICT (user_id, task_id) DO NOTHING',
                [':u' => $userId, ':t' => $task['id'], ':p' => $task['points']]
            );
            if ($n === 0) return null; // already had it
            self::checkMilestones($userId);
            return ['task' => $task];
        } catch (\Throwable $e) {
            return null;
        }
    }

    private static function checkMilestones(string $userId): void
    {
        $s = self::summary($userId);
        $milestones = [
            ['milestone.points.100', $s['totalPoints'] >= 100],
            ['milestone.points.500', $s['totalPoints'] >= 500],
            ['milestone.points.1000', $s['totalPoints'] >= 1000],
            ['milestone.tasks.25', $s['completedCount'] >= 25],
            ['milestone.tasks.50', $s['completedCount'] >= 50],
        ];
        foreach ($milestones as [$cond, $ok]) {
            if (!$ok) continue;
            $t = Db::one('SELECT * FROM reward_tasks WHERE completion_condition = :c LIMIT 1', [':c' => $cond]);
            if ($t) Db::run(
                'INSERT INTO user_reward_tasks (user_id, task_id, points_awarded) VALUES (:u,:t,:p)
                 ON CONFLICT (user_id, task_id) DO NOTHING',
                [':u' => $userId, ':t' => $t['id'], ':p' => $t['points']]
            );
        }
    }

    public static function summary(string $userId): array
    {
        $r = Db::one('SELECT COALESCE(SUM(points_awarded),0) AS total_points, COUNT(*) AS completed_count
                      FROM user_reward_tasks WHERE user_id = :u', [':u' => $userId]);
        return ['totalPoints' => (int) $r['totalPoints'], 'completedCount' => (int) $r['completedCount']];
    }

    public static function list(string $userId): array
    {
        $tasks = Db::all('SELECT * FROM reward_tasks ORDER BY code');
        $done = Db::all('SELECT * FROM user_reward_tasks WHERE user_id = :u', [':u' => $userId]);
        $map = [];
        foreach ($done as $d) $map[$d['taskId']] = $d;
        $out = array_map(function ($t) use ($map) {
            $d = $map[$t['id']] ?? null;
            return $t + [
                'completed' => $d !== null,
                'completedAt' => $d['completedAt'] ?? null,
                'pointsAwarded' => $d['pointsAwarded'] ?? null,
            ];
        }, $tasks);
        return ['summary' => self::summary($userId), 'tasks' => $out];
    }
}
