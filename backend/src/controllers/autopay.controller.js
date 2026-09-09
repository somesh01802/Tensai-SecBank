const { and, eq, desc } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const rewards = require("../services/rewards.service")
const { advanceNext } = require("../services/schedule.util")

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.investmentAutopay)
        .where(eq(schema.investmentAutopay.userId, req.user.id))
        .orderBy(desc(schema.investmentAutopay.createdAt))
    res.status(200).json({ autopays: rows.map(shape) })
}

async function create(req, res) {
    const {
        investmentId, sourceAccountId, amount,
        frequency = "MONTHLY", nextRunAt
    } = req.body || {}
    if (!investmentId || !sourceAccountId || !amount || !nextRunAt) {
        return res.status(400).json({ message: "investmentId, sourceAccountId, amount, nextRunAt required" })
    }
    const db = await getDb()
    const [row] = await db
        .insert(schema.investmentAutopay)
        .values({
            userId: req.user.id,
            investmentId,
            sourceAccountId,
            amount: Number(amount).toFixed(2),
            frequency,
            nextRunAt: new Date(nextRunAt),
            enabled: true
        })
        .returning()
    await rewards.awardByCondition(req.user.id, "autopay.enabled")
    res.status(201).json({ autopay: shape(row) })
}

async function toggle(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.investmentAutopay)
        .where(and(
            eq(schema.investmentAutopay.id, req.params.id),
            eq(schema.investmentAutopay.userId, req.user.id)
        ))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "AutoPay not found" })
    const [updated] = await db
        .update(schema.investmentAutopay)
        .set({ enabled: !rows[0].enabled, updatedAt: new Date() })
        .where(eq(schema.investmentAutopay.id, req.params.id))
        .returning()
    if (updated.enabled) await rewards.awardByCondition(req.user.id, "autopay.enabled")
    else await rewards.awardByCondition(req.user.id, "autopay.disabled")
    res.status(200).json({ autopay: shape(updated) })
}

async function remove(req, res) {
    const db = await getDb()
    const deleted = await db
        .delete(schema.investmentAutopay)
        .where(and(
            eq(schema.investmentAutopay.id, req.params.id),
            eq(schema.investmentAutopay.userId, req.user.id)
        ))
        .returning({ id: schema.investmentAutopay.id })
    if (deleted.length === 0) return res.status(404).json({ message: "AutoPay not found" })
    res.status(200).json({ message: "AutoPay deleted" })
}

async function history(req, res) {
    const db = await getDb()
    const rows = await db
        .select({
            id: schema.investmentAutopayRuns.id,
            autopayId: schema.investmentAutopayRuns.autopayId,
            amount: schema.investmentAutopayRuns.amount,
            status: schema.investmentAutopayRuns.status,
            reason: schema.investmentAutopayRuns.reason,
            runAt: schema.investmentAutopayRuns.runAt
        })
        .from(schema.investmentAutopayRuns)
        .innerJoin(schema.investmentAutopay, eq(schema.investmentAutopay.id, schema.investmentAutopayRuns.autopayId))
        .where(eq(schema.investmentAutopay.userId, req.user.id))
        .orderBy(desc(schema.investmentAutopayRuns.runAt))
    res.status(200).json({ runs: rows })
}

function shape(r) {
    return { ...r, amount: Number(r.amount) }
}

module.exports = { list, create, toggle, remove, history }
