/**
 * Development entry point for Tensai SecBank.
 *
 * Boots an embedded PostgreSQL (PGlite) so the developer doesn't need to
 * install PostgreSQL. Data is persisted under ./.pg-data so accounts and
 * transactions survive nodemon restarts. Also starts the scheduler that
 * processes due AutoPay / recurring bills / scheduled transfers.
 */

require("dotenv").config()
const path = require("path")

async function boot() {
    const dataDir = path.join(__dirname, ".pg-data")
    if (!process.env.DATABASE_URL) {
        process.env.DATABASE_URL = `pglite://${dataDir}`
    }

    console.log("[tensai-secbank] booting embedded PostgreSQL (PGlite)…")

    const { runMigrations, getDb } = require("./src/db")
    const { seedSystemUser } = require("./src/db/seed")
    const { seedCatalog } = require("./src/db/catalogSeed")
    await getDb()
    await runMigrations()
    await seedSystemUser()
    await seedCatalog()

    console.log("[db] connected to " + process.env.DATABASE_URL.replace(/:\/\/.*@/, "://"))

    const scheduler = require("./src/services/scheduler")
    scheduler.start()

    const app = require("./src/app")
    const PORT = process.env.PORT || 3000
    app.listen(PORT, () => {
        console.log(`[tensai-secbank] API running on port ${PORT}`)
    })
}

boot().catch((err) => {
    console.error("[tensai-secbank] failed to start:", err)
    process.exit(1)
})
