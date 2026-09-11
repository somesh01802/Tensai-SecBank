const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const { eq, or } = require("drizzle-orm")

const { getDb, schema } = require("../db")
const { seedDemoDataForUser } = require("../db/demoDataSeed")
const { seedWelcomeNotifications } = require("../services/notifications.service")
const { generateAccountNumber } = require("../services/accountNumber")
const mpinService = require("../services/mpin.service")
const rewards = require("../services/rewards.service")
const emailService = require("../services/email.service")
const { getTelemetry } = require("../telemetry")
const t = () => getTelemetry?.()

const JWT_TTL_DAYS = 3
const COOKIE_OPTS = () => ({
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: JWT_TTL_DAYS * 24 * 60 * 60 * 1000
})

function signToken(userId) {
    return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: `${JWT_TTL_DAYS}d` })
}

const emailRe = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const mobileRe = /^[0-9]{10}$/

/**
 * POST /api/auth/register
 * Body: { name, email, password, mobileNumber }
 */
async function userRegisterController(req, res) {
    const { email, password, name, mobileNumber } = req.body

    if (!email || !password || !name || !mobileNumber) {
        return res.status(400).json({ message: "name, email, password and mobileNumber are required" })
    }
    if (!emailRe.test(email)) return res.status(400).json({ message: "Invalid email address" })
    if (!mobileRe.test(mobileNumber)) return res.status(400).json({ message: "Mobile number must be exactly 10 digits" })
    if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" })

    const db = await getDb()

    const existing = await db
        .select({ id: schema.users.id, email: schema.users.email, mobile: schema.users.mobileNumber })
        .from(schema.users)
        .where(or(
            eq(schema.users.email, email.toLowerCase()),
            eq(schema.users.mobileNumber, mobileNumber)
        ))
        .limit(1)

    if (existing.length) {
        const reason = existing[0].email === email.toLowerCase() ? "email" : "mobile number"
        t()?.metrics?.authFailures?.add(1, { flow: "register", reason: "duplicate" })
        return res.status(422).json({ message: `A user with this ${reason} already exists` })
    }
    t()?.metrics?.authAttempts?.add(1, { flow: "register" })

    const passwordHash = await bcrypt.hash(password, 10)

    const [user] = await db
        .insert(schema.users)
        .values({ email: email.toLowerCase(), name, passwordHash, mobileNumber })
        .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name, mobileNumber: schema.users.mobileNumber })

    // Provision default account + demo data + notifications
    try {
        const acctNumber = await generateAccountNumber()
        const [defaultAccount] = await db
            .insert(schema.accounts)
            .values({
                userId: user.id,
                accountNumber: acctNumber,
                kind: "SAVINGS",
                displayName: "Primary Savings",
                isPrimary: true
            })
            .returning()
        await seedStarterBalance(db, defaultAccount.id, 100000)
        await seedDemoDataForUser(user.id, user.name)
        await seedWelcomeNotifications(user.id)
    } catch (err) {
        console.error("[auth.register] provisioning failed:", err.message)
    }

    const token = signToken(user.id)
    res.cookie("token", token, COOKIE_OPTS())
    res.status(201).json({ user, token, needsMpin: true })

    emailService.sendRegistrationEmail(user.email, user.name).catch(() => {})
}

/**
 * POST /api/auth/login
 * Body: { email?, mobileNumber?, password?, mpin? }
 * Accepts either password login (email or mobile + password) OR MPIN login (mobile + mpin).
 */
async function userLoginController(req, res) {
    const { email, mobileNumber, password, mpin } = req.body || {}

    if (!password && !mpin) {
        return res.status(400).json({ message: "Provide password or MPIN" })
    }
    if (!email && !mobileNumber) {
        return res.status(400).json({ message: "Provide email or mobile number" })
    }

    const db = await getDb()

    const rows = await db
        .select()
        .from(schema.users)
        .where(or(
            email ? eq(schema.users.email, String(email).toLowerCase()) : eq(schema.users.email, "___never___"),
            mobileNumber ? eq(schema.users.mobileNumber, mobileNumber) : eq(schema.users.mobileNumber, "___never___")
        ))
        .limit(1)

    t()?.metrics?.authAttempts?.add(1, { flow: mpin ? "login.mpin" : "login.password" })

    if (rows.length === 0) {
        t()?.metrics?.authFailures?.add(1, { flow: "login", reason: "unknown_user" })
        return res.status(401).json({ message: "Credentials are invalid" })
    }

    const user = rows[0]

    if (mpin) {
        const v = await mpinService.verifyMpin(user.id, mpin)
        if (!v.ok) {
            t()?.metrics?.authFailures?.add(1, { flow: "login.mpin", reason: "bad_mpin" })
            return res.status(401).json({ message: v.message, attemptsRemaining: v.attemptsRemaining })
        }
    } else {
        const ok = await bcrypt.compare(password, user.passwordHash)
        if (!ok) {
            t()?.metrics?.authFailures?.add(1, { flow: "login.password", reason: "bad_password" })
            return res.status(401).json({ message: "Credentials are invalid" })
        }
    }

    const token = signToken(user.id)
    res.cookie("token", token, COOKIE_OPTS())

    res.status(200).json({
        user: {
            id: user.id, email: user.email, name: user.name, mobileNumber: user.mobileNumber
        },
        token,
        hasMpin: await mpinService.hasMpin(user.id)
    })
}

/**
 * POST /api/auth/logout
 */
async function userLogoutController(req, res) {
    const token = req.cookies.token || req.headers.authorization?.split(" ")[1]
    if (token) {
        const db = await getDb()
        const expiresAt = new Date(Date.now() + JWT_TTL_DAYS * 24 * 60 * 60 * 1000)
        try {
            await db
                .insert(schema.revokedTokens)
                .values({ token, expiresAt })
                .onConflictDoNothing()
        } catch { /* ignore */ }
    }
    res.clearCookie("token")
    res.status(200).json({ message: "User logged out successfully" })
}

/**
 * GET /api/auth/me
 */
async function getCurrentUserController(req, res) {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" })
    return res.status(200).json({
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            mobileNumber: req.user.mobileNumber
        },
        hasMpin: await mpinService.hasMpin(req.user.id)
    })
}

/**
 * POST /api/auth/mpin  (set or reset MPIN)
 * Body: { mpin }
 */
async function setMpinController(req, res) {
    const { mpin } = req.body || {}
    const result = await mpinService.setMpin(req.user.id, mpin)
    if (!result.ok) return res.status(400).json({ message: result.message })
    await rewards.awardByCondition(req.user.id, "mpin.created")
    res.status(200).json({ message: "MPIN saved" })
}

async function hasMpinController(req, res) {
    res.status(200).json({ hasMpin: await mpinService.hasMpin(req.user.id) })
}

/**
 * Give a brand-new account a synthetic opening balance using a self-crediting
 * transaction so the ledger stays consistent.
 */
async function seedStarterBalance(db, accountId, amount) {
    const key = `welcome-bonus-${accountId}`
    const [tx] = await db
        .insert(schema.transactions)
        .values({
            fromAccountId: accountId,
            toAccountId: accountId,
            amount: amount.toFixed(2),
            status: "COMPLETED",
            idempotencyKey: key,
            description: "Tensai SecBank welcome bonus",
            category: "WELCOME_BONUS"
        })
        .returning()
    await db.insert(schema.ledgerEntries).values({
        accountId,
        transactionId: tx.id,
        type: "CREDIT",
        amount: amount.toFixed(2)
    })
}

module.exports = {
    userRegisterController,
    userLoginController,
    userLogoutController,
    getCurrentUserController,
    setMpinController,
    hasMpinController
}
