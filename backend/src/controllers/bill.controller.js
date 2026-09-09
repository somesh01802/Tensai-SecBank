const { and, eq, asc } = require("drizzle-orm")
const { getDb, schema } = require("../db")

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.bills)
        .where(eq(schema.bills.userId, req.user.id))
        .orderBy(asc(schema.bills.dueDate))
    res.status(200).json({ bills: rows })
}

async function create(req, res) {
    const { billerName, category, amount, dueDate, iconHint } = req.body
    if (!billerName || !category || amount == null) {
        return res.status(400).json({ message: "billerName, category and amount are required" })
    }
    const db = await getDb()
    const [row] = await db
        .insert(schema.bills)
        .values({
            userId: req.user.id,
            billerName,
            category,
            amount: Number(amount).toFixed(2),
            dueDate: dueDate ? new Date(dueDate) : null,
            iconHint: iconHint ?? null,
            status: "DUE"
        })
        .returning()
    res.status(201).json({ bill: row })
}

/**
 * Mark a bill paid. If `fromAccountId` is provided, actually debit that account
 * via the same idempotent transfer machinery so the ledger stays consistent.
 * If not, we just flip the flag (record-keeping only).
 */
async function pay(req, res) {
    const { fromAccountId } = req.body || {}
    const db = await getDb()

    const found = await db
        .select()
        .from(schema.bills)
        .where(and(eq(schema.bills.id, req.params.id), eq(schema.bills.userId, req.user.id)))
        .limit(1)
    if (found.length === 0) return res.status(404).json({ message: "Bill not found" })
    const bill = found[0]
    if (bill.status === "PAID") {
        return res.status(200).json({ message: "Bill already paid", bill })
    }

    let paidTxId = null
    if (fromAccountId) {
        // Reuse the transfer machinery: debit the account and credit a
        // "biller account" (fromAccountId → fromAccountId self-transfer is
        // logically wrong so we synthesize a self-debit ledger entry).
        try {
            const result = await db.transaction(async (tx) => {
                const [txRow] = await tx
                    .insert(schema.transactions)
                    .values({
                        fromAccountId,
                        toAccountId: fromAccountId,
                        amount: bill.amount,
                        status: "COMPLETED",
                        idempotencyKey: `bill-${bill.id}-${Date.now()}`,
                        description: `Bill payment · ${bill.billerName}`,
                        category: bill.category
                    })
                    .returning()
                await tx.insert(schema.ledgerEntries).values({
                    accountId: fromAccountId,
                    transactionId: txRow.id,
                    type: "DEBIT",
                    amount: bill.amount
                })
                return txRow
            })
            paidTxId = result.id
        } catch (err) {
            return res.status(500).json({ message: "Payment failed", detail: err.message })
        }
    }

    const [row] = await db
        .update(schema.bills)
        .set({
            status: "PAID",
            paidAt: new Date(),
            paidTxId
        })
        .where(eq(schema.bills.id, bill.id))
        .returning()
    res.status(200).json({ message: "Bill paid", bill: row })
}

async function remove(req, res) {
    const db = await getDb()
    const deleted = await db
        .delete(schema.bills)
        .where(and(eq(schema.bills.id, req.params.id), eq(schema.bills.userId, req.user.id)))
        .returning({ id: schema.bills.id })
    if (deleted.length === 0) return res.status(404).json({ message: "Bill not found" })
    res.status(200).json({ message: "Bill removed" })
}

module.exports = { list, create, pay, remove }
