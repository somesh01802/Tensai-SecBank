const { and, eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const { BANKS } = require("../services/banks")
const { debitAccount } = require("../services/transfer.service")
const rewards = require("../services/rewards.service")
const { advanceNext } = require("../services/schedule.util")

/**
 * POST /api/transfer/quick
 * Body:
 *   { bankName, accountNumber, confirmAccountNumber, accountHolderName,
 *     amount, remarks, sourceAccountId, idempotencyKey, savePayee? }
 *
 * Debits the source account (real ledger DEBIT). The recipient is external so
 * there's no matching CREDIT — this reflects real-world inter-bank movement.
 */
async function quickTransfer(req, res) {
    const {
        bankName, accountNumber, confirmAccountNumber, accountHolderName,
        amount, remarks, sourceAccountId, idempotencyKey, savePayee
    } = req.body || {}

    if (!bankName || !accountNumber || !confirmAccountNumber || !accountHolderName || !amount || !sourceAccountId || !idempotencyKey) {
        return res.status(400).json({ message: "Missing required fields" })
    }
    if (!BANKS.includes(bankName)) return res.status(400).json({ message: "Unknown bank" })
    if (accountNumber !== confirmAccountNumber) {
        return res.status(400).json({ message: "Account numbers do not match" })
    }

    const db = await getDb()

    const src = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, sourceAccountId), eq(schema.accounts.userId, req.user.id)))
        .limit(1)
    if (src.length === 0) return res.status(404).json({ message: "Source account not found" })

    try {
        const tx = await debitAccount({
            fromAccountId: sourceAccountId,
            amount,
            idempotencyKey,
            description: `Transfer to ${accountHolderName} (${bankName})`,
            category: "TRANSFER_EXTERNAL"
        })

        if (savePayee) {
            try {
                await db
                    .insert(schema.payees)
                    .values({
                        userId: req.user.id,
                        bankName,
                        accountNumber,
                        accountHolderName: accountHolderName.trim(),
                        nickname: accountHolderName.trim(),
                        active: true
                    })
                    .onConflictDoNothing()
            } catch { /* ignore */ }
        }

        await rewards.awardByCondition(req.user.id, "transfer.quick.first")
        if (Number(amount) >= 500) await rewards.awardByCondition(req.user.id, "transfer.amount.gte.500")
        if (Number(amount) >= 5000) await rewards.awardByCondition(req.user.id, "transfer.amount.gte.5000")
        if (remarks) await rewards.awardByCondition(req.user.id, "transfer.remarks")

        return res.status(201).json({ message: "Transfer complete", transaction: tx })
    } catch (err) {
        if (err.code === "INSUFFICIENT_BALANCE") {
            return res.status(400).json({ message: "Insufficient balance", available: err.available })
        }
        console.error("[quickTransfer]", err)
        return res.status(500).json({ message: "Transfer failed" })
    }
}

async function createScheduled(req, res) {
    const {
        payeeId, sourceAccountId, amount, remarks,
        frequency = "ONCE", nextRunAt
    } = req.body || {}
    if (!payeeId || !sourceAccountId || !amount || !nextRunAt) {
        return res.status(400).json({ message: "payeeId, sourceAccountId, amount, nextRunAt required" })
    }
    const db = await getDb()
    const [row] = await db
        .insert(schema.scheduledTransfers)
        .values({
            userId: req.user.id,
            payeeId,
            sourceAccountId,
            amount: Number(amount).toFixed(2),
            remarks: remarks ?? null,
            frequency,
            nextRunAt: new Date(nextRunAt),
            enabled: true,
            status: "SCHEDULED"
        })
        .returning()
    await rewards.awardByCondition(req.user.id, "scheduled_transfer.created")
    res.status(201).json({ scheduledTransfer: row })
}

async function listScheduled(req, res) {
    const db = await getDb()
    const rows = await db
        .select({
            id: schema.scheduledTransfers.id,
            payeeId: schema.scheduledTransfers.payeeId,
            payeeName: schema.payees.nickname,
            bankName: schema.payees.bankName,
            sourceAccountId: schema.scheduledTransfers.sourceAccountId,
            amount: schema.scheduledTransfers.amount,
            remarks: schema.scheduledTransfers.remarks,
            frequency: schema.scheduledTransfers.frequency,
            nextRunAt: schema.scheduledTransfers.nextRunAt,
            enabled: schema.scheduledTransfers.enabled,
            status: schema.scheduledTransfers.status,
            createdAt: schema.scheduledTransfers.createdAt
        })
        .from(schema.scheduledTransfers)
        .innerJoin(schema.payees, eq(schema.payees.id, schema.scheduledTransfers.payeeId))
        .where(eq(schema.scheduledTransfers.userId, req.user.id))
    res.status(200).json({ scheduledTransfers: rows.map((r) => ({ ...r, amount: Number(r.amount) })) })
}

async function toggleScheduled(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.scheduledTransfers)
        .where(and(
            eq(schema.scheduledTransfers.id, req.params.id),
            eq(schema.scheduledTransfers.userId, req.user.id)
        ))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Not found" })
    const [row] = await db
        .update(schema.scheduledTransfers)
        .set({ enabled: !rows[0].enabled, updatedAt: new Date() })
        .where(eq(schema.scheduledTransfers.id, req.params.id))
        .returning()
    res.status(200).json({ scheduledTransfer: row })
}

async function cancelScheduled(req, res) {
    const db = await getDb()
    const [row] = await db
        .update(schema.scheduledTransfers)
        .set({ enabled: false, status: "CANCELLED", updatedAt: new Date() })
        .where(and(
            eq(schema.scheduledTransfers.id, req.params.id),
            eq(schema.scheduledTransfers.userId, req.user.id)
        ))
        .returning()
    if (!row) return res.status(404).json({ message: "Not found" })
    await rewards.awardByCondition(req.user.id, "scheduled_transfer.cancelled")
    res.status(200).json({ scheduledTransfer: row })
}

module.exports = { quickTransfer, createScheduled, listScheduled, toggleScheduled, cancelScheduled }
