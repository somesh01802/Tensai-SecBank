const express = require("express")
const cookieParser = require("cookie-parser")
const cors = require("cors")


const app = express()

/**
 * - CORS: allow the frontend (Vite dev server) to call the API with cookies.
 */
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map(o => o.trim())

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}))

app.use(express.json())
app.use(cookieParser())

/**
 * - Routes
 */
const authRouter = require("./routes/auth.routes")
const accountRouter = require("./routes/account.routes")
const transactionRoutes = require("./routes/transaction.routes")
const beneficiaryRoutes = require("./routes/beneficiary.routes")
const profileRoutes = require("./routes/profile.routes")
const dashboardRoutes = require("./routes/dashboard.routes")
const investmentRoutes = require("./routes/investment.routes")
const cardRoutes = require("./routes/card.routes")
const billRoutes = require("./routes/bill.routes")
const v2Routes = require("./routes/v2.routes")

app.get("/", (req, res) => {
    res.send("Tensai SecBank API is up and running")
})

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "tensai-secbank" })
})

app.use("/api/auth", authRouter)
app.use("/api/accounts", accountRouter)
app.use("/api/transactions", transactionRoutes)
app.use("/api/beneficiaries", beneficiaryRoutes)
app.use("/api/profile", profileRoutes)
app.use("/api/dashboard", dashboardRoutes)
app.use("/api/investments", investmentRoutes)
app.use("/api/cards", cardRoutes)
app.use("/api/bills", billRoutes)
app.use("/api", v2Routes)

// Central error handler
app.use((err, req, res, _next) => {
    console.error("[api] unhandled error:", err)
    res.status(500).json({ message: err.message || "Internal server error" })
})

module.exports = app
