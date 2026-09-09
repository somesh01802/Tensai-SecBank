const { and, eq, or, inArray, desc, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const { balancesForAccounts } = require("./account.controller")

/**
 * GET /api/dashboard/summary
 * Returns a single payload with everything the dashboard renders:
 *   - totalBalance across all user accounts
 *   - primary account
 *   - investments
 *   - cards
 *   - bills (unpaid)
 *   - recent transactions (last 10)
 *   - expenditure by category (donut source)
 *   - statistics: daily net for the last ~30 days (line chart source)
 *   - quickTransfer: recent beneficiaries + those the user transferred to lately
 */
async function summary(req, res) {
    const db = await getDb()
    const userId = req.user.id

    const [accounts, invs, cds, blls] = await Promise.all([
        db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)).orderBy(schema.accounts.createdAt),
        db.select().from(schema.investments).where(eq(schema.investments.userId, userId)),
        db.select().from(schema.cards).where(eq(schema.cards.userId, userId)),
        db.select().from(schema.bills).where(eq(schema.bills.userId, userId))
    ])

    const accountIds = accounts.map((a) => a.id)
    const balances = await balancesForAccounts(db, accountIds)
    const accountsWithBalance = accounts.map((a) => ({
        ...a,
        balance: balances.get(a.id) ?? 0
    }))
    const totalBalance = accountsWithBalance.reduce((s, a) => s + (a.balance || 0), 0)
    const primaryAccount = accountsWithBalance[0] ?? null

    // Recent transactions (last 10) with direction annotation
    const idSet = new Set(accountIds)
    const recentTx = accountIds.length
        ? await db
              .select()
              .from(schema.transactions)
              .where(
                  or(
                      inArray(schema.transactions.fromAccountId, accountIds),
                      inArray(schema.transactions.toAccountId, accountIds)
                  )
              )
              .orderBy(desc(schema.transactions.createdAt))
              .limit(10)
        : []
    const recentTransactions = recentTx.map((t) => ({
        id: t.id,
        fromAccount: t.fromAccountId,
        toAccount: t.toAccountId,
        amount: Number(t.amount),
        status: t.status,
        description: t.description,
        category: t.category,
        createdAt: t.createdAt,
        direction:
            idSet.has(t.fromAccountId) && idSet.has(t.toAccountId)
                ? "OUT"
                : idSet.has(t.fromAccountId)
                ? "OUT"
                : "IN"
    }))

    // Expenditure by category — sum of outgoing DEBITs in the last 30 days
    // grouped by transaction.category (fallback bucket 'Other').
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const expenditure = accountIds.length
        ? await db
              .select({
                  category: sql`COALESCE(${schema.transactions.category}, 'Other')`.as("category"),
                  total: sql`SUM(${schema.transactions.amount})`.as("total")
              })
              .from(schema.transactions)
              .where(
                  and(
                      inArray(schema.transactions.fromAccountId, accountIds),
                      eq(schema.transactions.status, "COMPLETED"),
                      sql`${schema.transactions.createdAt} >= ${cutoff}`
                  )
              )
              .groupBy(sql`COALESCE(${schema.transactions.category}, 'Other')`)
        : []
    const expenditureByCategory = expenditure.map((r) => ({
        category: r.category,
        total: Number(r.total)
    }))

    // Statistics: net change per day (last 30 days)
    const stats = accountIds.length
        ? await db
              .select({
                  day: sql`DATE(${schema.ledgerEntries.createdAt})`.as("day"),
                  net: sql`SUM(CASE WHEN ${schema.ledgerEntries.type} = 'CREDIT' THEN ${schema.ledgerEntries.amount} ELSE -${schema.ledgerEntries.amount} END)`.as("net")
              })
              .from(schema.ledgerEntries)
              .where(
                  and(
                      inArray(schema.ledgerEntries.accountId, accountIds),
                      sql`${schema.ledgerEntries.createdAt} >= ${cutoff}`
                  )
              )
              .groupBy(sql`DATE(${schema.ledgerEntries.createdAt})`)
              .orderBy(sql`DATE(${schema.ledgerEntries.createdAt})`)
        : []
    const statistics = stats.map((r) => ({
        day: r.day,
        net: Number(r.net)
    }))

    // Quick transfer: saved beneficiaries
    const benefRows = await db
        .select({
            id: schema.beneficiaries.id,
            nickname: schema.beneficiaries.nickname,
            toAccountId: schema.beneficiaries.toAccountId,
            beneficiaryOwnerName: schema.users.name
        })
        .from(schema.beneficiaries)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.beneficiaries.toAccountId))
        .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
        .where(eq(schema.beneficiaries.userId, userId))
        .limit(6)

    res.status(200).json({
        totalBalance,
        accounts: accountsWithBalance,
        primaryAccount,
        investments: invs.map((i) => ({
            ...i,
            investedAmount: Number(i.investedAmount),
            currentValue: Number(i.currentValue),
            monthlyContribution:
                i.monthlyContribution != null ? Number(i.monthlyContribution) : null,
            returnPct: i.returnPct != null ? Number(i.returnPct) : null
        })),
        cards: cds,
        bills: blls
            .filter((b) => b.status !== "PAID")
            .map((b) => ({ ...b, amount: Number(b.amount) })),
        recentTransactions,
        expenditureByCategory,
        statistics,
        quickTransfer: benefRows
    })
}

module.exports = { summary }
