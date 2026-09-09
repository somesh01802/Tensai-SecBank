const { sql, eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")

/**
 * Debit an account inside a real PostgreSQL transaction.
 * - Inserts a `transactions` row (COMPLETED)
 * - Inserts a DEBIT ledger entry
 * - Verifies post-debit balance is non-negative; otherwise rolls back
 *
 * `toAccount` is optional. If omitted (bill payment), the transaction is
 * recorded as a self-transfer but only one DEBIT ledger row is inserted.
 */
async function debitAccount({
    fromAccountId,
    toAccountId = null,
    amount,
    idempotencyKey,
    description,
    category
}) {
    const db = await getDb()
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid amount")

    return db.transaction(async (tx) => {
        const [txRow] = await tx
            .insert(schema.transactions)
            .values({
                fromAccountId,
                toAccountId: toAccountId || fromAccountId,
                amount: amt.toFixed(2),
                status: "COMPLETED",
                idempotencyKey,
                description: description ?? null,
                category: category ?? null
            })
            .returning()

        await tx.insert(schema.ledgerEntries).values({
            accountId: fromAccountId,
            transactionId: txRow.id,
            type: "DEBIT",
            amount: amt.toFixed(2)
        })

        // Balance check inside the tx (concurrent-safe).
        const balRows = await tx.execute(sql`
            SELECT COALESCE(SUM(
                CASE WHEN type='CREDIT' THEN amount ELSE -amount END
            ), 0) AS balance
            FROM ledger_entries
            WHERE account_id = ${fromAccountId}
        `)
        const balance = Number(balRows.rows?.[0]?.balance ?? balRows[0]?.balance ?? 0)
        if (balance < 0) {
            const err = new Error("Insufficient balance")
            err.code = "INSUFFICIENT_BALANCE"
            err.available = balance + amt
            throw err
        }

        // If this is a genuine transfer (different accounts), credit the recipient.
        if (toAccountId && toAccountId !== fromAccountId) {
            await tx.insert(schema.ledgerEntries).values({
                accountId: toAccountId,
                transactionId: txRow.id,
                type: "CREDIT",
                amount: amt.toFixed(2)
            })
        }

        return txRow
    })
}

module.exports = { debitAccount }
