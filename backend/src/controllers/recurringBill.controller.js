const { and, eq, desc } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const rewards = require("../services/rewards.service")
const provider = require("../services/billProvider.demo")

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.recurringBills)
        .where(eq(schema.recurringBills.userId, req.user.id))
        .orderBy(desc(schema.recurringBills.createdAt))
    res.status(200).json({ recurringBills: rows.map(shape) })
}

async function create(req, res) {
    const {
        billerName, category, providerHint,
        amount, autoDetectAmount = false,
        frequency = "MONTHLY", sourceAccountId,
        autopayEnabled = true, nextRunAt
    } = req.body || {}
    if (!billerName || !category || !nextRunAt) {
        return res.status(400).json({ message: "billerName, category, nextRunAt required" })
    }

    let effectiveAmount = amount
    if (autoDetectAmount) {
        const q = await provider.fetchAmount({ billerName, category })
        effectiveAmount = q.amount
    }
    if (!effectiveAmount) return res.status(400).json({ message: "amount is required (or enable auto-detect)" })

    const db = await getDb()
    const [row] = await db
        .insert(schema.recurringBills)
        .values({
            userId: req.user.id,
            billerName,
            category,
            providerHint: providerHint ?? null,
            amount: Number(effectiveAmount).toFixed(2),
            autoDetectAmount,
            frequency,
            sourceAccountId: sourceAccountId ?? null,
            autopayEnabled: Boolean(autopayEnabled),
            nextRunAt: new Date(nextRunAt),
            enabled: true
        })
        .returning()

    await rewards.awardByCondition(req.user.id, "recurring_bill.created")
    if (autopayEnabled) await rewards.awardByCondition(req.user.id, "recurring_bill.autopay_enabled")
    if (autoDetectAmount) await rewards.awardByCondition(req.user.id, "recurring_bill.auto_detect_used")

    res.status(201).json({ recurringBill: shape(row) })
}

async function autoDetect(req, res) {
    const { billerName, category } = req.body || {}
    if (!billerName || !category) return res.status(400).json({ message: "billerName + category required" })
    const q = await provider.fetchAmount({ billerName, category })
    await rewards.awardByCondition(req.user.id, "recurring_bill.auto_detect_used")
    res.status(200).json(q)
}

async function toggle(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.recurringBills)
        .where(and(
            eq(schema.recurringBills.id, req.params.id),
            eq(schema.recurringBills.userId, req.user.id)
        ))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Not found" })
    const [row] = await db
        .update(schema.recurringBills)
        .set({ enabled: !rows[0].enabled, updatedAt: new Date() })
        .where(eq(schema.recurringBills.id, req.params.id))
        .returning()
    res.status(200).json({ recurringBill: shape(row) })
}

async function remove(req, res) {
    const db = await getDb()
    const deleted = await db
        .delete(schema.recurringBills)
        .where(and(
            eq(schema.recurringBills.id, req.params.id),
            eq(schema.recurringBills.userId, req.user.id)
        ))
        .returning({ id: schema.recurringBills.id })
    if (deleted.length === 0) return res.status(404).json({ message: "Not found" })
    await rewards.awardByCondition(req.user.id, "recurring_bill.deleted")
    res.status(200).json({ message: "Recurring bill removed" })
}

async function history(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.recurringBillRuns)
        .innerJoin(schema.recurringBills, eq(schema.recurringBills.id, schema.recurringBillRuns.recurringBillId))
        .where(eq(schema.recurringBills.userId, req.user.id))
        .orderBy(desc(schema.recurringBillRuns.runAt))
    res.status(200).json({ runs: rows.map((r) => r.recurring_bill_runs || r) })
}

function shape(r) { return { ...r, amount: Number(r.amount) } }

module.exports = { list, create, autoDetect, toggle, remove, history }
