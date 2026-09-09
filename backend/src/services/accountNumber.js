const { eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")

/**
 * Generate a unique 10-digit account number.
 * Loops until an unused number is found (typically 1 attempt).
 */
async function generateAccountNumber() {
    const db = await getDb()
    for (let i = 0; i < 5; i++) {
        // Range 1_000_000_000 .. 9_999_999_999 (10 digits)
        const n = String(1_000_000_000 + Math.floor(Math.random() * 9_000_000_000))
        const dup = await db
            .select({ id: schema.accounts.id })
            .from(schema.accounts)
            .where(eq(schema.accounts.accountNumber, n))
            .limit(1)
        if (dup.length === 0) return n
    }
    throw new Error("Could not allocate a unique account number")
}

module.exports = { generateAccountNumber }
