const { and, eq, or, inArray, sql, desc } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const { balancesForAccounts } = require("./account.controller")
const emailService = require("../services/email.service")

/**
 * Optional dev-only simulation delay to demo the "pending" UX on the frontend.
 * Set TRANSFER_SIMULATION_DELAY_MS=0 in .env to disable.
 */
const SIMULATION_DELAY_MS = Number(process.env.TRANSFER_SIMULATION_DELAY_MS ?? 0)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * POST /api/transactions
 *
 * ACID transfer:
 *   1. Validate + idempotency check
 *   2. In a PG transaction:
 *      - Insert transaction (PENDING)
 *      - Insert DEBIT ledger row for sender
 *      - Verify sender balance is non-negative (business rule)
 *      - Insert CREDIT ledger row for recipient
 *      - Update transaction to COMPLETED
 *   3. If anything fails, PG rolls the whole thing back.
 */
async function createTransaction(req, res) {
    const { fromAccount, toAccount, amount, idempotencyKey, description } = req.body

    if (!fromAccount || !toAccount || !amount || !idempotencyKey) {
        return res.status(400).json({
            message: "fromAccount, toAccount, amount and idempotencyKey are required"
        })
    }

    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ message: "amount must be a positive number" })
    }

    if (fromAccount === toAccount) {
        return res.status(400).json({ message: "Cannot transfer to the same account" })
    }

    const db = await getDb()

    // 1. Idempotency: if a transaction with this key already exists, replay its status.
    const existing = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.idempotencyKey, idempotencyKey))
        .limit(1)

    if (existing.length) {
        const t = existing[0]
        if (t.status === "COMPLETED") {
            return res.status(200).json({ message: "Transaction already processed", transaction: shape(t) })
        }
        if (t.status === "PENDING") {
            return res.status(200).json({ message: "Transaction is still processing", transaction: shape(t) })
        }
        return res.status(409).json({ message: `Transaction previously ${t.status}, retry with a new idempotency key`, transaction: shape(t) })
    }

    // 2. Sender must be owned by the current user and both accounts must be ACTIVE.
    const [fromAcc, toAcc] = await Promise.all([
        db.select().from(schema.accounts).where(eq(schema.accounts.id, fromAccount)).limit(1),
        db.select().from(schema.accounts).where(eq(schema.accounts.id, toAccount)).limit(1)
    ])

    if (fromAcc.length === 0 || toAcc.length === 0) {
        return res.status(404).json({ message: "Invalid fromAccount or toAccount" })
    }
    if (fromAcc[0].userId !== req.user.id) {
        return res.status(403).json({ message: "You do not own the source account" })
    }
    if (fromAcc[0].status !== "ACTIVE" || toAcc[0].status !== "ACTIVE") {
        return res.status(400).json({ message: "Both accounts must be ACTIVE" })
    }

    // Optional demo delay (keeps the frontend's 15s pending-state UX meaningful)
    if (SIMULATION_DELAY_MS > 0) await sleep(SIMULATION_DELAY_MS)

    // 3. ACID: everything below either all commits or all rolls back.
    let completed
    try {
        completed = await db.transaction(async (tx) => {
            const [txRow] = await tx
                .insert(schema.transactions)
                .values({
                    fromAccountId: fromAccount,
                    toAccountId: toAccount,
                    amount: amt.toFixed(2),
                    status: "PENDING",
                    idempotencyKey,
                    description: description ?? null
                })
                .returning()

            await tx.insert(schema.ledgerEntries).values({
                accountId: fromAccount,
                transactionId: txRow.id,
                type: "DEBIT",
                amount: amt.toFixed(2)
            })

            // Balance check happens INSIDE the tx after the DEBIT is written so
            // concurrent transfers can't overspend the account.
            const balRows = await tx.execute(sql`
                SELECT COALESCE(SUM(
                    CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END
                ), 0) AS balance
                FROM ledger_entries
                WHERE account_id = ${fromAccount}
            `)
            const balance = Number(balRows.rows?.[0]?.balance ?? balRows[0]?.balance ?? 0)
            if (balance < 0) {
                const err = new Error("Insufficient balance")
                err.code = "INSUFFICIENT_BALANCE"
                err.available = balance + amt
                throw err
            }

            await tx.insert(schema.ledgerEntries).values({
                accountId: toAccount,
                transactionId: txRow.id,
                type: "CREDIT",
                amount: amt.toFixed(2)
            })

            const [updated] = await tx
                .update(schema.transactions)
                .set({ status: "COMPLETED", updatedAt: new Date() })
                .where(eq(schema.transactions.id, txRow.id))
                .returning()

            return updated
        })
    } catch (err) {
        if (err.code === "INSUFFICIENT_BALANCE") {
            return res.status(400).json({
                message: `Insufficient balance. Available: ${err.available}, Requested: ${amt}`
            })
        }
        console.error("[transaction] failed:", err)
        return res.status(500).json({ message: "Transaction failed, please retry" })
    }

    // 4. Fire-and-forget email
    emailService
        .sendTransactionEmail(req.user.email, req.user.name, amt, toAccount)
        .catch(() => {})

    return res.status(201).json({
        message: "Transaction completed successfully",
        transaction: shape(completed)
    })
}

/**
 * GET /api/transactions?from=&to=&limit=
 * All transactions involving any of the user's accounts, optionally date-filtered.
 * Date filtering is done in the DB, not on the frontend.
 */
async function getUserTransactions(req, res) {
    const db = await getDb()

    const myAccounts = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, req.user.id))

    if (myAccounts.length === 0) return res.status(200).json({ transactions: [], totals: emptyTotals() })

    const ids = myAccounts.map((a) => a.id)
    const idSet = new Set(ids)

    const { from, to } = parseDateRange(req.query)
    const limit = Math.min(Number(req.query.limit) || 500, 2000)

    const conditions = [
        or(
            inArray(schema.transactions.fromAccountId, ids),
            inArray(schema.transactions.toAccountId, ids)
        )
    ]
    if (from) conditions.push(sql`${schema.transactions.createdAt} >= ${from}`)
    if (to) conditions.push(sql`${schema.transactions.createdAt} <= ${to}`)

    const rows = await db
        .select()
        .from(schema.transactions)
        .where(and(...conditions))
        .orderBy(desc(schema.transactions.createdAt))
        .limit(limit)

    const transactions = rows.map((t) => {
        const isSelfTransfer = t.fromAccountId === t.toAccountId
        const isOwnedFrom = idSet.has(t.fromAccountId)
        const isOwnedTo = idSet.has(t.toAccountId)
        let direction
        if (isSelfTransfer) {
            direction = t.category === "WELCOME_BONUS" || t.category === "DEPOSIT" ? "IN" : "OUT"
        } else if (isOwnedFrom && isOwnedTo) {
            direction = "OUT" // internal transfer — listed as OUT with a matching IN entry via ledger
        } else if (isOwnedFrom) {
            direction = "OUT"
        } else {
            direction = "IN"
        }
        return { ...shape(t), direction }
    })

    const totals = {
        count: transactions.length,
        credit: transactions.filter((t) => t.direction === "IN" && t.status === "COMPLETED").reduce((s, t) => s + t.amount, 0),
        debit: transactions.filter((t) => t.direction === "OUT" && t.status === "COMPLETED").reduce((s, t) => s + t.amount, 0)
    }

    res.status(200).json({ transactions, totals, filter: { from, to } })
}

function emptyTotals() { return { count: 0, credit: 0, debit: 0 } }

function parseDateRange(query) {
    let from, to
    if (query.from) {
        const d = new Date(query.from)
        if (!isNaN(d.getTime())) from = d
    }
    if (query.to) {
        const d = new Date(query.to)
        if (!isNaN(d.getTime())) to = d
    }
    // If both provided, ensure order
    if (from && to && from > to) {
        const tmp = from; from = to; to = tmp
    }
    return { from, to }
}

/**
 * GET /api/transactions/statement.csv?from=&to=
 * Streams a CSV built from actual filtered PG data.
 */
async function downloadStatement(req, res) {
    const db = await getDb()
    const myAccounts = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, req.user.id))

    if (myAccounts.length === 0) {
        res.setHeader("Content-Type", "text/csv")
        res.setHeader("Content-Disposition", `attachment; filename="statement.csv"`)
        return res.status(200).send("No accounts\n")
    }

    const ids = myAccounts.map((a) => a.id)
    const idSet = new Set(ids)
    const acctById = new Map(myAccounts.map((a) => [a.id, a]))

    const { from, to } = parseDateRange(req.query)
    const conds = [
        or(
            inArray(schema.transactions.fromAccountId, ids),
            inArray(schema.transactions.toAccountId, ids)
        )
    ]
    if (from) conds.push(sql`${schema.transactions.createdAt} >= ${from}`)
    if (to) conds.push(sql`${schema.transactions.createdAt} <= ${to}`)

    const rows = await db
        .select()
        .from(schema.transactions)
        .where(and(...conds))
        .orderBy(schema.transactions.createdAt)  // ASC for running balance

    // Reconstruct per-account running balance by replaying ledger DEBIT/CREDIT.
    // For the statement's Balance column we use aggregate over the primary account.
    const primary = myAccounts.find((a) => a.isPrimary) || myAccounts[0]
    let running = 0
    // Compute prior balance (before `from`) so the statement's opening line is right.
    if (from) {
        const prior = await db
            .select({ total: sql`COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END), 0)`.as("total") })
            .from(schema.ledgerEntries)
            .where(and(
                eq(schema.ledgerEntries.accountId, primary.id),
                sql`${schema.ledgerEntries.createdAt} < ${from}`
            ))
        running = Number(prior[0]?.total ?? 0)
    } else {
        // full history: opening balance is 0
        running = 0
    }

    const header = [
        "Date/Time", "Reference", "Description", "Category",
        "Type", "Direction", "Debit", "Credit", "Balance", "Status"
    ]
    const lines = [header.join(",")]

    for (const t of rows) {
        const isOwnedFrom = idSet.has(t.fromAccountId)
        const isOwnedTo = idSet.has(t.toAccountId)
        const direction =
            t.fromAccountId === t.toAccountId
                ? (t.category === "WELCOME_BONUS" || t.category === "DEPOSIT" ? "IN" : "OUT")
                : isOwnedFrom && isOwnedTo ? (t.fromAccountId === primary.id ? "OUT" : "IN")
                : isOwnedFrom ? "OUT"
                : "IN"

        // Only apply the running balance if the primary account is involved.
        const affectsPrimary = t.fromAccountId === primary.id || t.toAccountId === primary.id
        if (affectsPrimary) {
            const amt = Number(t.amount)
            if (t.category === "WELCOME_BONUS" || t.category === "DEPOSIT") {
                running += amt
            } else if (t.fromAccountId === primary.id && t.toAccountId === primary.id) {
                running -= amt   // billy pay/self-debit
            } else if (t.fromAccountId === primary.id) {
                running -= amt
            } else if (t.toAccountId === primary.id) {
                running += amt
            }
        }

        const debit = direction === "OUT" ? Number(t.amount).toFixed(2) : ""
        const credit = direction === "IN" ? Number(t.amount).toFixed(2) : ""
        lines.push([
            csv(t.createdAt.toISOString()),
            csv(String(t.id).slice(0, 8)),
            csv(t.description || ""),
            csv(t.category || ""),
            csv("Transfer"),
            csv(direction),
            debit,
            credit,
            affectsPrimary ? running.toFixed(2) : "",
            csv(t.status)
        ].join(","))
    }

    const filename = `tensai-statement-${(from || new Date(0)).toISOString().slice(0,10)}_to_${(to || new Date()).toISOString().slice(0,10)}.csv`
    res.setHeader("Content-Type", "text/csv")
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.status(200).send(lines.join("\n"))
}

function csv(v) {
    const s = String(v ?? "")
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
}

/**
 * POST /api/transactions/receive
 * Demo "receive money" — credits the user's primary account.
 * Body: { amount, remarks?, sourceInfo?, idempotencyKey }
 */
async function receiveMoney(req, res) {
    const { amount, remarks, sourceInfo, idempotencyKey } = req.body || {}
    if (!amount || !idempotencyKey) {
        return res.status(400).json({ message: "amount and idempotencyKey are required" })
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: "amount must be positive" })
    if (amt > 10_00_00_000) return res.status(400).json({ message: "amount exceeds allowed limit" })

    const db = await getDb()

    // Idempotency replay
    const dup = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.idempotencyKey, idempotencyKey))
        .limit(1)
    if (dup.length) {
        return res.status(200).json({ message: "Already credited", transaction: shape(dup[0]) })
    }

    // Find primary account
    const primaryRows = await db
        .select()
        .from(schema.accounts)
        .where(and(
            eq(schema.accounts.userId, req.user.id),
            eq(schema.accounts.isPrimary, true)
        ))
        .limit(1)
    if (primaryRows.length === 0) return res.status(400).json({ message: "No primary account found" })
    const primary = primaryRows[0]
    if (primary.status !== "ACTIVE") return res.status(400).json({ message: "Primary account is not active" })

    const description = remarks
        ? `Received: ${remarks}${sourceInfo ? " · from " + sourceInfo : ""}`
        : `Deposit${sourceInfo ? " from " + sourceInfo : ""}`

    const completed = await db.transaction(async (tx) => {
        const [txRow] = await tx
            .insert(schema.transactions)
            .values({
                fromAccountId: primary.id,
                toAccountId: primary.id,
                amount: amt.toFixed(2),
                status: "COMPLETED",
                idempotencyKey,
                description,
                category: "DEPOSIT"
            })
            .returning()
        await tx.insert(schema.ledgerEntries).values({
            accountId: primary.id,
            transactionId: txRow.id,
            type: "CREDIT",
            amount: amt.toFixed(2)
        })
        return txRow
    })

    res.status(201).json({ message: "Deposit credited", transaction: shape(completed) })
}

/**
 * POST /api/transactions/system/initial-funds
 */
async function createInitialFundsTransaction(req, res) {
    const { toAccount, amount, idempotencyKey } = req.body
    if (!toAccount || !amount || !idempotencyKey) {
        return res.status(400).json({ message: "toAccount, amount and idempotencyKey are required" })
    }

    const db = await getDb()

    // Ensure the system user has an account; create one if needed.
    let systemAccount = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, req.user.id))
        .limit(1)

    if (systemAccount.length === 0) {
        const [created] = await db
            .insert(schema.accounts)
            .values({ userId: req.user.id })
            .returning()
        systemAccount = [created]
    }

    const amt = Number(amount)

    const completed = await db.transaction(async (tx) => {
        const [txRow] = await tx
            .insert(schema.transactions)
            .values({
                fromAccountId: systemAccount[0].id,
                toAccountId: toAccount,
                amount: amt.toFixed(2),
                status: "COMPLETED",
                idempotencyKey
            })
            .returning()

        await tx.insert(schema.ledgerEntries).values([
            { accountId: systemAccount[0].id, transactionId: txRow.id, type: "DEBIT", amount: amt.toFixed(2) },
            { accountId: toAccount, transactionId: txRow.id, type: "CREDIT", amount: amt.toFixed(2) }
        ])

        return txRow
    })

    res.status(201).json({ message: "Initial funds transaction completed", transaction: shape(completed) })
}

function shape(t) {
    return {
        _id: t.id,
        id: t.id,
        fromAccount: t.fromAccountId,
        toAccount: t.toAccountId,
        amount: Number(t.amount),
        status: t.status,
        idempotencyKey: t.idempotencyKey,
        description: t.description,
        category: t.category,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
    }
}

module.exports = {
    createTransaction,
    createInitialFundsTransaction,
    getUserTransactions,
    downloadStatement,
    receiveMoney
}
