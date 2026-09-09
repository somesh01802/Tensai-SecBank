const { Router } = require("express")
const { authMiddleware, authSystemUserMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/transaction.controller")

const transactionRoutes = Router()

transactionRoutes.get("/statement.csv", authMiddleware, c.downloadStatement)
transactionRoutes.get("/", authMiddleware, c.getUserTransactions)
transactionRoutes.post("/", authMiddleware, c.createTransaction)
transactionRoutes.post("/receive", authMiddleware, c.receiveMoney)
transactionRoutes.post("/system/initial-funds", authSystemUserMiddleware, c.createInitialFundsTransaction)

module.exports = transactionRoutes
