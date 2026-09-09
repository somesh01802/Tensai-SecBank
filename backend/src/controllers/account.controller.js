const { and, eq, inArray, sql, ne } = require("drizzle-orm")
const { getDb, schema } = require("../db")

/**
 * Compute account balances via a single aggregate query:
 *   balance = SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END)
 */
async function balancesForAccounts(db, accountIds) {
    if (accountIds.length === 0) return new Map()

    const rows = await db
        .select({
            accountId: schema.ledgerEntries.accountId,
            balance: sql`
                COALESCE(SUM(
                    CASE WHEN ${schema.ledgerEntries.type} = 'CREDIT'
                         THEN ${schema.ledgerEntries.amount}
                         ELSE -${schema.ledgerEntries.amount}
                    END
                ), 0)`.as("balance")
        })
        .from(schema.ledgerEntries)
        .where(inArray(schema.ledgerEntries.accountId, accountIds))
        .groupBy(schema.ledgerEntries.accountId)

    const map = new Map()
    for (const r of rows) map.set(r.accountId, Number(r.balance))
    return map
}

async function createAccountController(req, res) {
    const db = await getDb()
    // Legacy simple create — never marked as primary by this route.
    const [account] = await db
        .insert(schema.accounts)
        .values({ userId: req.user.id })
        .returning()
    res.status(201).json({ account: { ...account, balance: 0 } })
}

async function getUserAccountsController(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, req.user.id))
        .orderBy(schema.accounts.createdAt)

    const balances = await balancesForAccounts(db, rows.map((a) => a.id))

    const accounts = rows.map((a) => ({
        ...a,
        balance: balances.get(a.id) ?? 0
    }))

    res.status(200).json({ accounts })
}

async function getAccountBalanceController(req, res) {
    const { accountId } = req.params
    const db = await getDb()

    const rows = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, req.user.id)))
        .limit(1)

    if (rows.length === 0) return res.status(404).json({ message: "Account not found" })

    const balances = await balancesForAccounts(db, [accountId])
    res.status(200).json({
        accountId,
        balance: balances.get(accountId) ?? 0
    })
}

/**
 * Account detail — everything a details modal needs.
 */
async function getAccountDetailController(req, res) {
    const { accountId } = req.params
    const db = await getDb()

    const rows = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, req.user.id)))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Account not found" })

    const a = rows[0]
    const balances = await balancesForAccounts(db, [accountId])
    const balance = balances.get(accountId) ?? 0

    // Latest few transactions on this account
    const recentRows = await db
        .select()
        .from(schema.transactions)
        .where(sql`${schema.transactions.fromAccountId} = ${accountId} OR ${schema.transactions.toAccountId} = ${accountId}`)
        .orderBy(sql`${schema.transactions.createdAt} DESC`)
        .limit(10)

    res.status(200).json({
        account: {
            ...a,
            balance,
            maskedNumber: a.accountNumber
                ? `xxxx xx${a.accountNumber.slice(-4)}`
                : null
        },
        recentTransactions: recentRows.map((r) => ({
            id: r.id,
            amount: Number(r.amount),
            description: r.description,
            direction: r.fromAccountId === accountId && r.toAccountId === accountId
                ? "IN"
                : r.fromAccountId === accountId ? "OUT" : "IN",
            status: r.status,
            createdAt: r.createdAt,
            category: r.category
        }))
    })
}

/**
 * Close an account.
 * - Primary account can never be closed.
 * - Account with non-zero balance is rejected — user must move funds first.
 * - Uses status='CLOSED' + closed_at; the row + ledger remain for history.
 */
async function closeAccountController(req, res) {
    const { accountId } = req.params
    const db = await getDb()

    const rows = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, req.user.id)))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Account not found" })
    const acc = rows[0]

    if (acc.isPrimary) {
        return res.status(400).json({ message: "Primary account cannot be closed." })
    }
    if (acc.status === "CLOSED") {
        return res.status(400).json({ message: "Account already closed." })
    }

    const balances = await balancesForAccounts(db, [accountId])
    const balance = balances.get(accountId) ?? 0
    if (Math.abs(balance) > 0.005) {
        return res.status(400).json({
            message: `Balance is ${balance.toFixed(2)}. Move funds out before closing.`,
            balance
        })
    }

    const [updated] = await db
        .update(schema.accounts)
        .set({ status: "CLOSED", closedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.accounts.id, accountId))
        .returning()

    return res.status(200).json({ account: { ...updated, balance } })
}

/**
 * PATCH /api/accounts/:accountId
 * Currently supports renaming (displayName).
 */
async function renameAccountController(req, res) {
    const { accountId } = req.params
    const { displayName } = req.body || {}
    if (!displayName || typeof displayName !== "string") {
        return res.status(400).json({ message: "displayName is required" })
    }
    const db = await getDb()
    const [row] = await db
        .update(schema.accounts)
        .set({ displayName: displayName.trim(), updatedAt: new Date() })
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, req.user.id)))
        .returning()
    if (!row) return res.status(404).json({ message: "Account not found" })
    res.status(200).json({ account: row })
}

async function getAccountLedgerController(req, res) {
    const { accountId } = req.params
    const db = await getDb()

    const rows = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, req.user.id)))
        .limit(1)

    if (rows.length === 0) return res.status(404).json({ message: "Account not found" })

    const entries = await db
        .select({
            id: schema.ledgerEntries.id,
            accountId: schema.ledgerEntries.accountId,
            transactionId: schema.ledgerEntries.transactionId,
            type: schema.ledgerEntries.type,
            amount: schema.ledgerEntries.amount,
            createdAt: schema.ledgerEntries.createdAt,
            transactionStatus: schema.transactions.status,
            fromAccount: schema.transactions.fromAccountId,
            toAccount: schema.transactions.toAccountId
        })
        .from(schema.ledgerEntries)
        .innerJoin(
            schema.transactions,
            eq(schema.transactions.id, schema.ledgerEntries.transactionId)
        )
        .where(eq(schema.ledgerEntries.accountId, accountId))
        .orderBy(schema.ledgerEntries.createdAt)

    const shaped = entries.map((e) => ({
        _id: e.id,
        account: e.accountId,
        type: e.type,
        amount: Number(e.amount),
        transaction: {
            _id: e.transactionId,
            status: e.transactionStatus,
            createdAt: e.createdAt,
            fromAccount: e.fromAccount,
            toAccount: e.toAccount
        }
    }))

    res.status(200).json({ accountId, entries: shaped })
}

module.exports = {
    createAccountController,
    getUserAccountsController,
    getAccountBalanceController,
    getAccountLedgerController,
    getAccountDetailController,
    closeAccountController,
    renameAccountController,
    balancesForAccounts
}
