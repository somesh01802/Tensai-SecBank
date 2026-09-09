const { and, eq, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")

/**
 * Award a specific reward task to a user exactly once.
 * The unique index on (user_id, task_id) enforces idempotency at the DB layer.
 */
async function awardByCondition(userId, condition) {
    const db = await getDb()

    const task = await db
        .select()
        .from(schema.rewardTasks)
        .where(eq(schema.rewardTasks.completionCondition, condition))
        .limit(1)
    if (task.length === 0) return null

    try {
        const [row] = await db
            .insert(schema.userRewardTasks)
            .values({
                userId,
                taskId: task[0].id,
                pointsAwarded: task[0].points
            })
            .returning()

        // Cascade milestone rewards
        await checkMilestones(userId)

        return { task: task[0], row }
    } catch (err) {
        if (String(err.message || "").includes("user_reward_task_unique")) return null
        throw err
    }
}

async function checkMilestones(userId) {
    const db = await getDb()
    const summary = await getSummary(userId)

    const points = summary.totalPoints
    const count = summary.completedCount

    const milestones = [
        ["milestone.points.100", points >= 100],
        ["milestone.points.500", points >= 500],
        ["milestone.points.1000", points >= 1000],
        ["milestone.tasks.25", count >= 25],
        ["milestone.tasks.50", count >= 50]
    ]
    for (const [cond, ok] of milestones) {
        if (ok) {
            const t = await db
                .select()
                .from(schema.rewardTasks)
                .where(eq(schema.rewardTasks.completionCondition, cond))
                .limit(1)
            if (t.length) {
                try {
                    await db
                        .insert(schema.userRewardTasks)
                        .values({ userId, taskId: t[0].id, pointsAwarded: t[0].points })
                } catch { /* dup */ }
            }
        }
    }
}

async function getSummary(userId) {
    const db = await getDb()
    const rows = await db
        .select({
            totalPoints: sql`COALESCE(SUM(${schema.userRewardTasks.pointsAwarded}), 0)`.as("totalPoints"),
            completedCount: sql`COUNT(*)`.as("completedCount")
        })
        .from(schema.userRewardTasks)
        .where(eq(schema.userRewardTasks.userId, userId))
    return {
        totalPoints: Number(rows[0]?.totalPoints ?? 0),
        completedCount: Number(rows[0]?.completedCount ?? 0)
    }
}

async function list(userId) {
    const db = await getDb()
    const tasks = await db
        .select()
        .from(schema.rewardTasks)
        .orderBy(schema.rewardTasks.code)
    const done = await db
        .select()
        .from(schema.userRewardTasks)
        .where(eq(schema.userRewardTasks.userId, userId))
    const doneMap = new Map(done.map((d) => [d.taskId, d]))
    const summary = await getSummary(userId)
    return {
        summary,
        tasks: tasks.map((t) => ({
            ...t,
            completed: doneMap.has(t.id),
            completedAt: doneMap.get(t.id)?.completedAt ?? null,
            pointsAwarded: doneMap.get(t.id)?.pointsAwarded ?? null
        }))
    }
}

module.exports = { awardByCondition, getSummary, list }
