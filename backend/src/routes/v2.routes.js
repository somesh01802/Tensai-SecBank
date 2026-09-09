const { Router } = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")

const notification = require("../controllers/notification.controller")
const accountApp = require("../controllers/accountApp.controller")
const loan = require("../controllers/loan.controller")
const autopay = require("../controllers/autopay.controller")
const cardApp = require("../controllers/cardApp.controller")
const payee = require("../controllers/payee.controller")
const quickTransfer = require("../controllers/quickTransfer.controller")
const recurring = require("../controllers/recurringBill.controller")
const stats = require("../controllers/statistics.controller")
const rewards = require("../controllers/rewards.controller")

const router = Router()

// notifications
router.get("/notifications", authMiddleware, notification.list)
router.post("/notifications/:id/read", authMiddleware, notification.markRead)
router.post("/notifications/read-all", authMiddleware, notification.markAllRead)

// account applications (Manage Account)
router.get("/account-applications", authMiddleware, accountApp.list)
router.post("/account-applications", authMiddleware, accountApp.apply)

// loans
router.get("/loans/products", authMiddleware, loan.listProducts)
router.post("/loans/calculate", authMiddleware, loan.calculate)
router.post("/loans/apply", authMiddleware, loan.apply)
router.get("/loans/applications", authMiddleware, loan.listApplications)
router.get("/loans/applications/:id", authMiddleware, loan.getApplicationDetail)
router.post("/loans/applications/:id/close", authMiddleware, loan.closeApplication)

// investment autopay
router.get("/autopay", authMiddleware, autopay.list)
router.post("/autopay", authMiddleware, autopay.create)
router.post("/autopay/:id/toggle", authMiddleware, autopay.toggle)
router.delete("/autopay/:id", authMiddleware, autopay.remove)
router.get("/autopay/history", authMiddleware, autopay.history)

// cards
router.get("/card-products", authMiddleware, cardApp.listProducts)
router.post("/card-applications", authMiddleware, cardApp.apply)
router.get("/card-applications", authMiddleware, cardApp.listApplications)
router.get("/cards/:id/reveal", authMiddleware, cardApp.revealCardDetails)

// payees
router.get("/payees/banks", authMiddleware, payee.banks)
router.get("/payees", authMiddleware, payee.list)
router.post("/payees", authMiddleware, payee.create)
router.patch("/payees/:id", authMiddleware, payee.update)
router.delete("/payees/:id", authMiddleware, payee.remove)

// transfers
router.post("/transfer/quick", authMiddleware, quickTransfer.quickTransfer)
router.get("/transfer/scheduled", authMiddleware, quickTransfer.listScheduled)
router.post("/transfer/scheduled", authMiddleware, quickTransfer.createScheduled)
router.post("/transfer/scheduled/:id/toggle", authMiddleware, quickTransfer.toggleScheduled)
router.post("/transfer/scheduled/:id/cancel", authMiddleware, quickTransfer.cancelScheduled)

// recurring bills
router.get("/recurring-bills", authMiddleware, recurring.list)
router.post("/recurring-bills", authMiddleware, recurring.create)
router.post("/recurring-bills/auto-detect", authMiddleware, recurring.autoDetect)
router.post("/recurring-bills/:id/toggle", authMiddleware, recurring.toggle)
router.delete("/recurring-bills/:id", authMiddleware, recurring.remove)
router.get("/recurring-bills/history", authMiddleware, recurring.history)

// statistics
router.get("/statistics", authMiddleware, stats.statistics)

// rewards
router.get("/rewards", authMiddleware, rewards.list)
router.post("/rewards/event", authMiddleware, rewards.event)

module.exports = router
