const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/chatbot.controller")

const router = express.Router()

// Simple, per-user rate limiter (in-memory; sufficient for single-instance demo)
const buckets = new Map()
function rateLimit(req, res, next) {
    const key = req.user?.id
    if (!key) return next()
    const now = Date.now()
    let b = buckets.get(key)
    if (!b || now - b.windowStart > 60_000) {
        b = { windowStart: now, count: 0 }
        buckets.set(key, b)
    }
    if (b.count >= 30) {
        return res.status(429).json({ message: "Too many chatbot requests. Please slow down." })
    }
    b.count += 1
    return next()
}

router.post("/message", authMiddleware, rateLimit, c.ask)

module.exports = router
