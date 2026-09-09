const { and, eq, desc } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const { BANKS } = require("../services/banks")
const rewards = require("../services/rewards.service")

async function banks(_req, res) {
    res.status(200).json({ banks: BANKS })
}

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.payees)
        .where(eq(schema.payees.userId, req.user.id))
        .orderBy(desc(schema.payees.createdAt))
    res.status(200).json({ payees: rows })
}

async function create(req, res) {
    const {
        bankName, accountNumber, confirmAccountNumber,
        accountHolderName, nickname
    } = req.body || {}

    if (!bankName || !accountNumber || !confirmAccountNumber || !accountHolderName || !nickname) {
        return res.status(400).json({ message: "All fields are required" })
    }
    if (!BANKS.includes(bankName)) return res.status(400).json({ message: "Unknown bank" })
    if (accountNumber !== confirmAccountNumber) {
        return res.status(400).json({ message: "Account numbers do not match" })
    }
    if (!/^\d{9,18}$/.test(accountNumber)) {
        return res.status(400).json({ message: "Account number must be 9–18 digits" })
    }

    const db = await getDb()
    try {
        const [row] = await db
            .insert(schema.payees)
            .values({
                userId: req.user.id,
                bankName,
                accountNumber,
                accountHolderName: accountHolderName.trim(),
                nickname: nickname.trim(),
                active: true
            })
            .returning()

        // Rewards
        await rewards.awardByCondition(req.user.id, "payee.added.first")
        await rewards.awardByCondition(req.user.id, "payee.acct_match")
        if (nickname.trim().length > 0) await rewards.awardByCondition(req.user.id, "payee.nickname.custom")
        const all = await db.select({ id: schema.payees.id }).from(schema.payees).where(eq(schema.payees.userId, req.user.id))
        if (all.length >= 3) await rewards.awardByCondition(req.user.id, "payee.count.gte.3")

        res.status(201).json({ payee: row })
    } catch (err) {
        if (String(err.message || "").includes("payees_user_acct_unique")) {
            return res.status(409).json({ message: "You already have a payee with this account number" })
        }
        console.error("[payee.create]", err)
        res.status(500).json({ message: "Could not save payee" })
    }
}

async function update(req, res) {
    const { nickname, accountHolderName, active } = req.body || {}
    const patch = {}
    if (nickname != null) patch.nickname = nickname
    if (accountHolderName != null) patch.accountHolderName = accountHolderName
    if (active != null) patch.active = Boolean(active)
    patch.updatedAt = new Date()
    if (Object.keys(patch).length === 1) return res.status(400).json({ message: "No changes" })

    const db = await getDb()
    const [row] = await db
        .update(schema.payees)
        .set(patch)
        .where(and(
            eq(schema.payees.id, req.params.id),
            eq(schema.payees.userId, req.user.id)
        ))
        .returning()
    if (!row) return res.status(404).json({ message: "Payee not found" })

    if (active === false) await rewards.awardByCondition(req.user.id, "payee.deactivated")
    if (active === true) await rewards.awardByCondition(req.user.id, "payee.reactivated")

    res.status(200).json({ payee: row })
}

async function remove(req, res) {
    const db = await getDb()
    const deleted = await db
        .delete(schema.payees)
        .where(and(eq(schema.payees.id, req.params.id), eq(schema.payees.userId, req.user.id)))
        .returning({ id: schema.payees.id })
    if (deleted.length === 0) return res.status(404).json({ message: "Payee not found" })
    await rewards.awardByCondition(req.user.id, "payee.deleted")
    res.status(200).json({ message: "Payee removed" })
}

module.exports = { banks, list, create, update, remove }
