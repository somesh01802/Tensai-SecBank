const rewards = require("../services/rewards.service")

async function list(req, res) {
    const data = await rewards.list(req.user.id)
    res.status(200).json(data)
}

/**
 * POST /api/rewards/event
 * Body: { condition }
 * Used by the frontend to record simple "explored X" style events.
 * Awards are idempotent via user_reward_tasks unique constraint.
 */
async function event(req, res) {
    const { condition } = req.body || {}
    if (!condition || typeof condition !== "string") {
        return res.status(400).json({ message: "condition required" })
    }
    const result = await rewards.awardByCondition(req.user.id, condition)
    res.status(200).json({
        awarded: Boolean(result),
        task: result?.task ? { code: result.task.code, title: result.task.title, points: result.task.points } : null
    })
}

module.exports = { list, event }
