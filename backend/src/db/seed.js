/**
 * Dev seed: creates a system-user + its account if none exists.
 *
 * Once the system user exists, use POST /api/transactions/system/initial-funds
 * (with a JWT for this user) to give any account starter money.
 *
 * Set SYSTEM_USER_EMAIL / SYSTEM_USER_PASSWORD in .env to override defaults.
 */

const bcrypt = require("bcryptjs")
const { eq } = require("drizzle-orm")

const { getDb, schema } = require("./index")

const DEFAULT_EMAIL = process.env.SYSTEM_USER_EMAIL || "system@tensai.local"
const DEFAULT_PASSWORD = process.env.SYSTEM_USER_PASSWORD || "system-secret-change-me"

async function seedSystemUser() {
    const db = await getDb()

    const existing = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, DEFAULT_EMAIL.toLowerCase()))
        .limit(1)

    if (existing.length) return existing[0]

    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10)
    const [user] = await db
        .insert(schema.users)
        .values({
            email: DEFAULT_EMAIL.toLowerCase(),
            name: "Tensai SecBank Treasury",
            passwordHash,
            systemUser: true
        })
        .returning()

    await db.insert(schema.accounts).values({ userId: user.id })

    console.log(`[seed] created system user ${DEFAULT_EMAIL} (password: ${DEFAULT_PASSWORD})`)
    return user
}

module.exports = { seedSystemUser }
