/**
 * Database client factory for Tensai SecBank.
 *
 * The app switches driver based on the DATABASE_URL:
 *   - pglite://<absolute-path>   -> embedded PGlite (dev / no server needed)
 *   - postgres://... / postgresql://...  -> real PostgreSQL via node-postgres
 *
 * `dev.js` uses PGlite for a zero-install developer experience.
 * `server.js` uses a real PostgreSQL for production.
 */

const path = require("path")
const fs = require("fs")
const schema = require("./schema")

let dbInstance = null
let closer = async () => {}

async function getDb() {
    if (dbInstance) return dbInstance
    const url = process.env.DATABASE_URL

    if (!url) {
        throw new Error(
            "DATABASE_URL is not set. Set it to postgres://user:pass@host:5432/db (prod) " +
            "or pglite://absolute/path (dev)."
        )
    }

    if (url.startsWith("pglite://")) {
        const dataDir = url.replace("pglite://", "")
        if (dataDir && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

        const { PGlite } = require("@electric-sql/pglite")
        const { drizzle } = require("drizzle-orm/pglite")

        const client = new PGlite(dataDir || undefined)
        await client.waitReady

        dbInstance = drizzle(client, { schema })
        // PGlite exposes .query for raw SQL — expose it for migrations
        dbInstance.$raw = (sql) => client.exec(sql)
        dbInstance.$rawQuery = async (sql) => {
            const r = await client.query(sql)
            return r
        }
        closer = async () => client.close()
        return dbInstance
    }

    // Real PostgreSQL
    const { Pool } = require("pg")
    const { drizzle } = require("drizzle-orm/node-postgres")
    const pool = new Pool({ connectionString: url })
    dbInstance = drizzle(pool, { schema })
    dbInstance.$raw = async (sql) => {
        const client = await pool.connect()
        try { await client.query(sql) } finally { client.release() }
    }
    closer = async () => pool.end()
    return dbInstance
}

async function closeDb() {
    await closer()
    dbInstance = null
}

/**
 * Idempotent migration runner: applies every .sql file under db/migrations
 * in alphabetical order. Files must be idempotent (use IF NOT EXISTS,
 * DO $$ ... EXCEPTION WHEN duplicate_object $$, etc.).
 */
async function runMigrations() {
    const db = await getDb()
    const dir = path.join(__dirname, "migrations")
    if (!fs.existsSync(dir)) return
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    for (const file of files) {
        const sql = fs.readFileSync(path.join(dir, file), "utf8")
        await db.$raw(sql)
        console.log(`[db] migration applied: ${file}`)
    }
}

module.exports = { getDb, closeDb, runMigrations, schema }
