const { and, eq, lte, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const { debitAccount } = require("./transfer.service")
const { advanceNext } = require("./schedule.util")
const provider = require("./billProvider.demo")
const rewards = require("./rewards.service")

/**
 * The scheduler runs every 60 seconds. Each tick it:
 *   1) processes due investment AutoPay contributions
 *   2) processes due recurring bills (autopay only)
 *   3) processes due scheduled transfers
 *
 * Each item is processed in isolation — one failure never blocks others.
 * Failures are recorded on the *_runs table so history is auditable.
 */
let intervalHandle = null

function start() {
    if (intervalHandle) return
    // Kick once shortly after boot, then every 60s
    setTimeout(tick, 5_000)
    intervalHandle = setInterval(tick, 60_000)
    console.log("[scheduler] started")
}
function stop() {
    if (intervalHandle) clearInterval(intervalHandle)
    intervalHandle = null
}

async function tick() {
    const { getTelemetry } = require("../telemetry")
    const tt = getTelemetry?.()
    tt?.metrics?.schedulerRuns?.add(1, { kind: "tick" })
    try { await processAutopay() } catch (e) { console.error("[scheduler autopay]", e.message) }
    try { await processRecurringBills() } catch (e) { console.error("[scheduler recurring]", e.message) }
    try { await processScheduledTransfers() } catch (e) { console.error("[scheduler transfers]", e.message) }
}

async function processAutopay() {
    const db = await getDb()
    const due = await db
        .select()
        .from(schema.investmentAutopay)
        .where(and(
            eq(schema.investmentAutopay.enabled, true),
            lte(schema.investmentAutopay.nextRunAt, new Date())
        ))
    for (const a of due) {
        const idem = `autopay-${a.id}-${a.nextRunAt.toISOString()}`
        try {
            const tx = await debitAccount({
                fromAccountId: a.sourceAccountId,
                amount: a.amount,
                idempotencyKey: idem,
                description: "Investment AutoPay",
                category: "INVESTMENTS"
            })
            await db.insert(schema.investmentAutopayRuns).values({
                autopayId: a.id, amount: a.amount, status: "SUCCESS", transactionId: tx.id
            })
            // Update investment invested_amount by the contribution
            await db.$raw(`UPDATE investments SET invested_amount = invested_amount + ${Number(a.amount).toFixed(2)}, current_value = current_value + ${Number(a.amount).toFixed(2)} WHERE id = '${a.investmentId}'`)
            await rewards.awardByCondition(a.userId, "autopay.ran")
        } catch (err) {
            await db.insert(schema.investmentAutopayRuns).values({
                autopayId: a.id, amount: a.amount, status: "FAILED",
                reason: err.code === "INSUFFICIENT_BALANCE" ? "Insufficient balance" : err.message
            })
        }
        const next = advanceNext(a.nextRunAt, a.frequency)
        await db.update(schema.investmentAutopay)
            .set({ nextRunAt: next ?? a.nextRunAt, enabled: next ? a.enabled : false, updatedAt: new Date() })
            .where(eq(schema.investmentAutopay.id, a.id))
    }
}

async function processRecurringBills() {
    const db = await getDb()
    const due = await db
        .select()
        .from(schema.recurringBills)
        .where(and(
            eq(schema.recurringBills.enabled, true),
            lte(schema.recurringBills.nextRunAt, new Date())
        ))
    for (const b of due) {
        // Refresh amount if auto-detect
        let effective = Number(b.amount)
        if (b.autoDetectAmount) {
            const q = await provider.fetchAmount({ billerName: b.billerName, category: b.category })
            effective = Number(q.amount)
        }

        const idem = `recur-${b.id}-${b.nextRunAt.toISOString()}`
        try {
            let txId = null
            let billId = null

            if (b.autopayEnabled && b.sourceAccountId) {
                const tx = await debitAccount({
                    fromAccountId: b.sourceAccountId,
                    amount: effective,
                    idempotencyKey: idem,
                    description: `Recurring bill · ${b.billerName}`,
                    category: b.category
                })
                txId = tx.id
            }

            // Log a bill row so bill history sees it
            const [bill] = await db.insert(schema.bills).values({
                userId: b.userId,
                billerName: b.billerName,
                category: b.category,
                amount: effective.toFixed(2),
                status: txId ? "PAID" : "DUE",
                paidAt: txId ? new Date() : null,
                paidTxId: txId ?? null
            }).returning()
            billId = bill.id

            await db.insert(schema.recurringBillRuns).values({
                recurringBillId: b.id,
                amount: effective.toFixed(2),
                status: txId ? "SUCCESS" : "SCHEDULED",
                transactionId: txId,
                billId
            })
            await rewards.awardByCondition(b.userId, "recurring_bill.ran")
        } catch (err) {
            await db.insert(schema.recurringBillRuns).values({
                recurringBillId: b.id,
                amount: effective.toFixed(2),
                status: "FAILED",
                reason: err.code === "INSUFFICIENT_BALANCE" ? "Insufficient balance" : err.message
            })
        }
        const next = advanceNext(b.nextRunAt, b.frequency)
        await db.update(schema.recurringBills)
            .set({ nextRunAt: next ?? b.nextRunAt, enabled: next ? b.enabled : false, amount: effective.toFixed(2), updatedAt: new Date() })
            .where(eq(schema.recurringBills.id, b.id))
    }
}

async function processScheduledTransfers() {
    const db = await getDb()
    const due = await db
        .select()
        .from(schema.scheduledTransfers)
        .where(and(
            eq(schema.scheduledTransfers.enabled, true),
            lte(schema.scheduledTransfers.nextRunAt, new Date())
        ))
    for (const s of due) {
        await db.update(schema.scheduledTransfers)
            .set({ status: "PROCESSING", updatedAt: new Date() })
            .where(eq(schema.scheduledTransfers.id, s.id))

        const idem = `sched-${s.id}-${s.nextRunAt.toISOString()}`
        try {
            const tx = await debitAccount({
                fromAccountId: s.sourceAccountId,
                amount: s.amount,
                idempotencyKey: idem,
                description: s.remarks || "Scheduled transfer",
                category: "TRANSFER_EXTERNAL"
            })
            await db.insert(schema.scheduledTransferRuns).values({
                scheduledTransferId: s.id, amount: s.amount, status: "SUCCESS", transactionId: tx.id
            })
            await db.update(schema.scheduledTransfers)
                .set({ status: "COMPLETED", updatedAt: new Date() })
                .where(eq(schema.scheduledTransfers.id, s.id))
            await rewards.awardByCondition(s.userId, "scheduled_transfer.ran")
        } catch (err) {
            await db.insert(schema.scheduledTransferRuns).values({
                scheduledTransferId: s.id, amount: s.amount, status: "FAILED",
                reason: err.code === "INSUFFICIENT_BALANCE" ? "Insufficient balance" : err.message
            })
            await db.update(schema.scheduledTransfers)
                .set({ status: "FAILED", updatedAt: new Date() })
                .where(eq(schema.scheduledTransfers.id, s.id))
        }
        const next = advanceNext(s.nextRunAt, s.frequency)
        await db.update(schema.scheduledTransfers)
            .set({
                nextRunAt: next ?? s.nextRunAt,
                enabled: Boolean(next),
                status: next ? "SCHEDULED" : (await db.select().from(schema.scheduledTransfers).where(eq(schema.scheduledTransfers.id, s.id)))[0]?.status,
                updatedAt: new Date()
            })
            .where(eq(schema.scheduledTransfers.id, s.id))
    }
}

module.exports = { start, stop, tick }
