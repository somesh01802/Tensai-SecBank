const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/bill.controller")

const router = express.Router()
router.get("/", authMiddleware, c.list)
router.post("/", authMiddleware, c.create)
router.post("/:id/pay", authMiddleware, c.pay)
router.delete("/:id", authMiddleware, c.remove)

module.exports = router
