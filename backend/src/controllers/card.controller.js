const { and, eq, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const rewards = require("../services/rewards.service")

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.cards)
        .where(and(eq(schema.cards.userId, req.user.id), sql`${schema.cards.deletedAt} IS NULL`))
        .orderBy(schema.cards.createdAt)
    // Return masked details by default
    res.status(200).json({
        cards: rows.map((c) => ({
            ...c,
            fullNumber: undefined,
            cvv: undefined
        }))
    })
}

async function create(req, res) {
    // Legacy quick-issue path (still used by dashboard "+ Add card")
    const { holderName, type = "CREDIT", brand = "MASTERCARD", colorHint = "peach", accountId } = req.body
    const holder = (holderName || req.user.name || "Card Holder").trim()
    const db = await getDb()

    function randomDigits(n) { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s }
    const fullNumber = "5" + randomDigits(15)
    const cvv = randomDigits(3)

    const [row] = await db
        .insert(schema.cards)
        .values({
            userId: req.user.id,
            accountId: accountId ?? null,
            holderName: holder,
            lastFour: fullNumber.slice(-4),
            fullNumber,
            cvv,
            expiryMonth: 1 + Math.floor(Math.random() * 12),
            expiryYear: (new Date().getFullYear() + 3) % 100,
            type,
            brand,
            colorHint,
            network: brand
        })
        .returning()
    res.status(201).json({ card: { ...row, fullNumber: undefined, cvv: undefined } })
}

async function toggleFreeze(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.cards)
        .where(and(
            eq(schema.cards.id, req.params.id),
            eq(schema.cards.userId, req.user.id),
            sql`${schema.cards.deletedAt} IS NULL`
        ))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Card not found" })
    const [row] = await db
        .update(schema.cards)
        .set({ isFrozen: !rows[0].isFrozen })
        .where(eq(schema.cards.id, req.params.id))
        .returning()
    if (row.isFrozen) await rewards.awardByCondition(req.user.id, "card.frozen")
    else await rewards.awardByCondition(req.user.id, "card.unfrozen")
    res.status(200).json({ card: { ...row, fullNumber: undefined, cvv: undefined } })
}

async function remove(req, res) {
    const db = await getDb()
    // Soft-delete so historical audits still resolve.
    const [row] = await db
        .update(schema.cards)
        .set({ deletedAt: new Date() })
        .where(and(
            eq(schema.cards.id, req.params.id),
            eq(schema.cards.userId, req.user.id),
            sql`${schema.cards.deletedAt} IS NULL`
        ))
        .returning({ id: schema.cards.id })
    if (!row) return res.status(404).json({ message: "Card not found" })
    await rewards.awardByCondition(req.user.id, "card.cancelled")
    res.status(200).json({ message: "Card cancelled" })
}

module.exports = { list, create, toggleFreeze, remove }
