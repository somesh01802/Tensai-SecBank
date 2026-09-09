const { eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const { generateAccountNumber } = require("../services/accountNumber")
const rewards = require("../services/rewards.service")

const VALID_KINDS = ["SAVINGS", "SALARY", "NRI", "BUSINESS", "INVESTMENT"]

const DISPLAY_NAME = {
    SAVINGS: "Savings Account",
    SALARY: "Salary Account",
    NRI: "NRI Account",
    BUSINESS: "Business Account",
    INVESTMENT: "Investment Account"
}

async function apply(req, res) {
    const {
        kind,
        applicantName,
        pan,
        pinCode,
        occupation,
        mobileNumber,
        extra = {}
    } = req.body || {}

    if (!VALID_KINDS.includes(kind)) return res.status(400).json({ message: "Invalid account type" })
    if (!applicantName || !pan || !pinCode || !occupation || !mobileNumber) {
        return res.status(400).json({ message: "All fields are required" })
    }
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
        return res.status(400).json({ message: "PAN must match format AAAAA9999A" })
    }
    if (!/^\d{6}$/.test(pinCode)) return res.status(400).json({ message: "PIN code must be 6 digits" })
    if (!/^\d{10}$/.test(mobileNumber)) return res.status(400).json({ message: "Mobile number must be 10 digits" })

    const db = await getDb()

    // Auto-approve — this is a demo bank
    const acctNumber = await generateAccountNumber()
    const [account] = await db
        .insert(schema.accounts)
        .values({
            userId: req.user.id,
            accountNumber: acctNumber,
            kind,
            displayName: DISPLAY_NAME[kind]
        })
        .returning()

    const [application] = await db
        .insert(schema.accountApplications)
        .values({
            userId: req.user.id,
            kind,
            applicantName,
            pan,
            pinCode,
            occupation,
            mobileNumber,
            extra,
            status: "APPROVED",
            accountId: account.id,
            processedAt: new Date()
        })
        .returning()

    // Backfill user profile fields opportunistically
    await db
        .update(schema.users)
        .set({ pan, pinCode, occupation, mobileNumber })
        .where(eq(schema.users.id, req.user.id))

    // Rewards
    await rewards.awardByCondition(req.user.id, "account.opened.any")
    await rewards.awardByCondition(req.user.id, `account.opened.${kind}`)
    await rewards.awardByCondition(req.user.id, "account.pin_code.valid")

    // Recount accounts and award count milestones
    const all = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, req.user.id))
    if (all.length >= 2) await rewards.awardByCondition(req.user.id, "account.count.gte.2")
    if (all.length >= 3) await rewards.awardByCondition(req.user.id, "account.count.gte.3")

    res.status(201).json({ application, account })
}

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.accountApplications)
        .where(eq(schema.accountApplications.userId, req.user.id))
    res.status(200).json({ applications: rows })
}

module.exports = { apply, list, VALID_KINDS }
