const { and, eq, inArray, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")

const RANGES = { "1D": 1, "1W": 7, "1M": 30, "1Y": 365 }

async function statistics(req, res) {
    const range = (req.query.range || "1M").toUpperCase()
    const days = RANGES[range] || 30
    const bucket = range === "1D" ? "hour" : "day"

    const db = await getDb()
    const accounts = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, req.user.id))
    const ids = accounts.map((a) => a.id)
    if (ids.length === 0) return res.status(200).json({ range, bucket, points: [] })

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const rows = await db
        .select({
            ts: bucket === "hour"
                ? sql`date_trunc('hour', ${schema.ledgerEntries.createdAt})`.as("ts")
                : sql`date_trunc('day', ${schema.ledgerEntries.createdAt})`.as("ts"),
            net: sql`SUM(CASE WHEN ${schema.ledgerEntries.type} = 'CREDIT' THEN ${schema.ledgerEntries.amount} ELSE -${schema.ledgerEntries.amount} END)`.as("net")
        })
        .from(schema.ledgerEntries)
        .where(and(
            inArray(schema.ledgerEntries.accountId, ids),
            sql`${schema.ledgerEntries.createdAt} >= ${cutoff}`
        ))
        .groupBy(sql`1`)
        .orderBy(sql`1`)

    // Also fetch the balance BEFORE cutoff (to seed the running series)
    const priorRows = await db
        .select({ total: sql`COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END), 0)`.as("total") })
        .from(schema.ledgerEntries)
        .where(and(
            inArray(schema.ledgerEntries.accountId, ids),
            sql`${schema.ledgerEntries.createdAt} < ${cutoff}`
        ))
    let running = Number(priorRows[0]?.total ?? 0)

    const points = rows.map((r) => {
        running += Number(r.net)
        return {
            ts: r.ts,
            net: Number(r.net),
            balance: Math.round(running * 100) / 100
        }
    })

    res.status(200).json({ range, bucket, cutoff, points })
}

module.exports = { statistics, RANGES }
