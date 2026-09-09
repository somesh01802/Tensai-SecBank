const bcrypt = require("bcryptjs")
const { eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")

const LOCK_AFTER = 5
const LOCK_MINUTES = 15

function isValidMpin(mpin) {
    return typeof mpin === "string" && /^[0-9]{6}$/.test(mpin)
}

async function setMpin(userId, mpin) {
    if (!isValidMpin(mpin)) return { ok: false, message: "MPIN must be exactly 6 digits" }
    const db = await getDb()
    const hash = await bcrypt.hash(mpin, 10)
    // Upsert
    const existing = await db
        .select()
        .from(schema.mpinCredentials)
        .where(eq(schema.mpinCredentials.userId, userId))
        .limit(1)
    if (existing.length) {
        await db
            .update(schema.mpinCredentials)
            .set({ mpinHash: hash, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
            .where(eq(schema.mpinCredentials.userId, userId))
    } else {
        await db.insert(schema.mpinCredentials).values({ userId, mpinHash: hash })
    }
    return { ok: true }
}

async function verifyMpin(userId, mpin) {
    if (!isValidMpin(mpin)) return { ok: false, message: "Invalid MPIN format" }
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.mpinCredentials)
        .where(eq(schema.mpinCredentials.userId, userId))
        .limit(1)
    if (rows.length === 0) return { ok: false, message: "MPIN not set" }
    const row = rows[0]

    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
        return { ok: false, message: `Account locked. Try again after ${row.lockedUntil.toISOString()}` }
    }

    const match = await bcrypt.compare(mpin, row.mpinHash)
    if (!match) {
        const attempts = row.failedAttempts + 1
        const patch = { failedAttempts: attempts, updatedAt: new Date() }
        if (attempts >= LOCK_AFTER) {
            patch.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
            patch.failedAttempts = 0
        }
        await db
            .update(schema.mpinCredentials)
            .set(patch)
            .where(eq(schema.mpinCredentials.userId, userId))
        return { ok: false, message: "Incorrect MPIN", attemptsRemaining: Math.max(0, LOCK_AFTER - attempts) }
    }

    await db
        .update(schema.mpinCredentials)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.mpinCredentials.userId, userId))

    return { ok: true }
}

async function hasMpin(userId) {
    const db = await getDb()
    const rows = await db
        .select({ userId: schema.mpinCredentials.userId })
        .from(schema.mpinCredentials)
        .where(eq(schema.mpinCredentials.userId, userId))
        .limit(1)
    return rows.length > 0
}

module.exports = { setMpin, verifyMpin, hasMpin, isValidMpin }
