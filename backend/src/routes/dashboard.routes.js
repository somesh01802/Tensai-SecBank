const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/dashboard.controller")

const router = express.Router()
router.get("/summary", authMiddleware, c.summary)

module.exports = router
