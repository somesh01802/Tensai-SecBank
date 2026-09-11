const { and, eq, isNull } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const rewards = require("../services/rewards.service")
const { getTelemetry } = require("../telemetry")
const t = () => getTelemetry?.()

function randomDigits(n) {
    let s = ""
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
    return s
}

async function listProducts(req, res) {
    const { category, type } = req.query
    const db = await getDb()
    const conds = []
    if (category) conds.push(`category = '${String(category).replace(/'/g, "''")}'`)
    if (type) conds.push(`card_type = '${String(type).replace(/'/g, "''")}'`)
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const raw = await db.$rawQuery(`SELECT id, code, category, card_type, name, tagline, benefits::text as benefits, annual_fee, color_hint, network FROM card_products ${where}`)
    const rows = (raw?.rows || raw || []).map((r) => ({
        id: r.id,
        code: r.code,
        category: r.category,
        cardType: r.card_type,
        name: r.name,
        tagline: r.tagline,
        benefits: (() => { try { return JSON.parse(r.benefits) } catch { return [] } })(),
        annualFee: Number(r.annual_fee),
        colorHint: r.color_hint,
        network: r.network
    }))
    res.status(200).json({ products: rows })
}

async function apply(req, res) {
    console.log("[cardApp] apply called, body:", JSON.stringify(req.body))
    try {
    const { productCode, mobileNumber, pan, dob } = req.body || {}
    if (!productCode || !mobileNumber || !pan || !dob) {
        return res.status(400).json({ message: "productCode, mobileNumber, pan, dob required" })
    }
    if (!/^\d{10}$/.test(mobileNumber)) return res.status(400).json({ message: "Mobile number must be 10 digits" })
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return res.status(400).json({ message: "Invalid PAN format" })

    const db = await getDb()
    const productsRaw = await db.$rawQuery(`SELECT id, code, category, card_type, name, tagline, color_hint, network FROM card_products WHERE code = '${String(productCode).replace(/'/g, "''")}' LIMIT 1`)
    const rows = productsRaw?.rows || productsRaw || []
    if (rows.length === 0) return res.status(404).json({ message: "Card product not found" })
    const p = {
        id: rows[0].id,
        code: rows[0].code,
        category: rows[0].category,
        cardType: rows[0].card_type,
        name: rows[0].name,
        tagline: rows[0].tagline,
        colorHint: rows[0].color_hint,
        network: rows[0].network
    }
    console.log("[cardApp] product:", JSON.stringify(p))

    // Generate demo card details
    const fullNumber = "5" + randomDigits(15)      // 16 digits, Mastercard-ish leading 5
    const cvv = randomDigits(3)
    const now = new Date()
    const expiryMonth = ((now.getMonth() + Math.floor(Math.random() * 12)) % 12) + 1
    const expiryYear = (now.getFullYear() + 3) % 100

    // Raw SQL insert avoids Drizzle/PGlite param quirks
    const cardId = require("crypto").randomUUID()
    const holder = (req.user.name || "Card Holder").replace(/'/g, "''")
    await db.$raw(`
        INSERT INTO cards (id, user_id, holder_name, product_id, last_four, full_number, cvv,
                           expiry_month, expiry_year, type, brand, color_hint, network)
        VALUES ('${cardId}', '${req.user.id}', '${holder}', '${p.id}', '${fullNumber.slice(-4)}',
                '${fullNumber}', '${cvv}', ${expiryMonth}, ${expiryYear},
                '${p.cardType}', '${p.network.replace(/'/g, "''")}', '${p.colorHint.replace(/'/g, "''")}',
                '${p.network.replace(/'/g, "''")}')
    `)
    const cardRows = await db
        .select()
        .from(schema.cards)
        .where(eq(schema.cards.id, cardId))
        .limit(1)
    const card = cardRows[0]

    const appId = require("crypto").randomUUID()
    const dobStr = String(dob).slice(0, 10)
    await db.$raw(`
        INSERT INTO card_applications (id, user_id, product_id, mobile_number, pan, dob,
                                       status, card_id, processed_at)
        VALUES ('${appId}', '${req.user.id}', '${p.id}', '${mobileNumber}', '${pan}',
                '${dobStr}', 'APPROVED', '${card.id}', NOW())
    `)
    const appRows = await db
        .select()
        .from(schema.cardApplications)
        .where(eq(schema.cardApplications.id, appId))
        .limit(1)
    const application = appRows[0]

    await rewards.awardByCondition(req.user.id, "card.applied.first")
    await rewards.awardByCondition(req.user.id, `card.applied.${p.cardType}`)
    await rewards.awardByCondition(req.user.id, `card.applied.${p.category}`)
    await rewards.awardByCondition(req.user.id, "card.app.dob")
    await rewards.awardByCondition(req.user.id, "card.app.pan")
    try {
        const activeCount = await db.$rawQuery(`SELECT COUNT(*)::int AS n FROM cards WHERE user_id = '${req.user.id}' AND deleted_at IS NULL`)
        const n = Number(activeCount?.rows?.[0]?.n ?? activeCount?.[0]?.n ?? 0)
        if (n >= 2) await rewards.awardByCondition(req.user.id, "card.active.gte.2")
    } catch { /* non-fatal */ }

    t()?.metrics?.cardsIssued?.add(1, { category: p.category, type: p.cardType })
    res.status(201).json({ application, card })
    } catch (err) {
        t()?.metrics?.businessErrors?.add(1, { op: "card.apply", reason: "server_error" })
        console.error("[cardApp.apply] hard error:", err.message, err.stack?.split("\n").slice(0,3).join(" | "))
        return res.status(500).json({ message: "Card application failed: " + err.message })
    }
}

async function listApplications(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.cardApplications)
        .where(eq(schema.cardApplications.userId, req.user.id))
    res.status(200).json({ applications: rows })
}

async function revealCardDetails(req, res) {
    // Returns the full card number / CVV. Frontend gates behind eye toggle.
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.cards)
        .where(and(eq(schema.cards.id, req.params.id), eq(schema.cards.userId, req.user.id)))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Card not found" })
    await rewards.awardByCondition(req.user.id, "card.number.revealed")
    await rewards.awardByCondition(req.user.id, "card.cvv.revealed")
    res.status(200).json({
        fullNumber: rows[0].fullNumber,
        cvv: rows[0].cvv,
        expiry: `${String(rows[0].expiryMonth).padStart(2, "0")}/${String(rows[0].expiryYear).padStart(2, "0")}`
    })
}

module.exports = { listProducts, apply, listApplications, revealCardDetails }
