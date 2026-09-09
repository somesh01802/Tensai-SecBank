/**
 * Production entry point. Uses whatever DATABASE_URL is configured in .env
 * (a real PostgreSQL instance). For local dev, use `npm run dev` instead —
 * that boots an embedded PGlite so no DB install is needed.
 */

require("dotenv").config()

async function boot() {
    const { getDb, runMigrations } = require("./src/db")
    await getDb()
    await runMigrations()

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
