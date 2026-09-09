const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/card.controller")

const router = express.Router()
router.get("/", authMiddleware, c.list)
router.post("/", authMiddleware, c.create)
router.post("/:id/freeze", authMiddleware, c.toggleFreeze)
router.delete("/:id", authMiddleware, c.remove)

module.exports = router
