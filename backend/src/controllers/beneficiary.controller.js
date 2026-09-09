const { and, eq, desc } = require("drizzle-orm")
const { getDb, schema } = require("../db")

/**
 * GET /api/beneficiaries
 */
async function listBeneficiaries(req, res) {
    const db = await getDb()
    const rows = await db
        .select({
            id: schema.beneficiaries.id,
            nickname: schema.beneficiaries.nickname,
            toAccountId: schema.beneficiaries.toAccountId,
            createdAt: schema.beneficiaries.createdAt,
            beneficiaryAccountStatus: schema.accounts.status,
            beneficiaryOwnerName: schema.users.name
        })
        .from(schema.beneficiaries)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.beneficiaries.toAccountId))
        .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
        .where(eq(schema.beneficiaries.userId, req.user.id))
        .orderBy(desc(schema.beneficiaries.createdAt))

    res.status(200).json({ beneficiaries: rows })
}

/**
 * POST /api/beneficiaries
 * body: { nickname, toAccountId }
 */
async function createBeneficiary(req, res) {
    const { nickname, toAccountId } = req.body

    if (!nickname || !toAccountId) {
        return res.status(400).json({ message: "nickname and toAccountId are required" })
    }

    const db = await getDb()

    const target = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, toAccountId))
        .limit(1)

    if (target.length === 0) return res.status(404).json({ message: "Target account not found" })
    if (target[0].userId === req.user.id) {
        return res.status(400).json({ message: "Cannot add your own account as a beneficiary" })
    }

    try {
        const [row] = await db
            .insert(schema.beneficiaries)
            .values({ userId: req.user.id, nickname: nickname.trim(), toAccountId })
            .returning()
        return res.status(201).json({ beneficiary: row })
    } catch (err) {
        if (String(err.message || "").includes("beneficiaries_user_account_unique")) {
            return res.status(409).json({ message: "This account is already a beneficiary" })
        }
        console.error("[beneficiary] create failed:", err)
        return res.status(500).json({ message: "Could not add beneficiary" })
    }
}

/**
 * DELETE /api/beneficiaries/:id
 */
async function deleteBeneficiary(req, res) {
    const db = await getDb()
    const deleted = await db
        .delete(schema.beneficiaries)
        .where(and(eq(schema.beneficiaries.id, req.params.id), eq(schema.beneficiaries.userId, req.user.id)))
        .returning({ id: schema.beneficiaries.id })

    if (deleted.length === 0) return res.status(404).json({ message: "Beneficiary not found" })
    res.status(200).json({ message: "Beneficiary removed" })
}

module.exports = { listBeneficiaries, createBeneficiary, deleteBeneficiary }
