const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/account.controller")

const router = express.Router()

router.post("/", authMiddleware, c.createAccountController)
router.get("/", authMiddleware, c.getUserAccountsController)
router.get("/balance/:accountId", authMiddleware, c.getAccountBalanceController)
router.get("/:accountId/detail", authMiddleware, c.getAccountDetailController)
router.get("/:accountId/ledger", authMiddleware, c.getAccountLedgerController)
router.patch("/:accountId", authMiddleware, c.renameAccountController)
router.post("/:accountId/close", authMiddleware, c.closeAccountController)

module.exports = router
