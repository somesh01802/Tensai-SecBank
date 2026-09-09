const { and, eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.investments)
        .where(eq(schema.investments.userId, req.user.id))
        .orderBy(schema.investments.createdAt)
    res.status(200).json({ investments: rows })
}

async function create(req, res) {
    const { type, name, investedAmount, currentValue, monthlyContribution, returnPct, frequencyLabel } = req.body
    if (!type || !name || investedAmount == null) {
        return res.status(400).json({ message: "type, name and investedAmount are required" })
    }
    const db = await getDb()
    const [row] = await db
        .insert(schema.investments)
        .values({
            userId: req.user.id,
            type,
            name,
            investedAmount: Number(investedAmount).toFixed(2),
            currentValue: (currentValue != null ? Number(currentValue) : Number(investedAmount)).toFixed(2),
            monthlyContribution: monthlyContribution != null ? Number(monthlyContribution).toFixed(2) : null,
            returnPct: returnPct != null ? Number(returnPct).toFixed(2) : null,
            frequencyLabel: frequencyLabel ?? null
        })
        .returning()
    res.status(201).json({ investment: row })
}

async function remove(req, res) {
    const db = await getDb()
    const deleted = await db
        .delete(schema.investments)
        .where(and(eq(schema.investments.id, req.params.id), eq(schema.investments.userId, req.user.id)))
        .returning({ id: schema.investments.id })
    if (deleted.length === 0) return res.status(404).json({ message: "Investment not found" })
    res.status(200).json({ message: "Investment removed" })
}

module.exports = { list, create, remove }
