const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/profile.controller")

const router = express.Router()

router.get("/", authMiddleware, c.getProfile)
router.patch("/", authMiddleware, c.updateProfile)
router.post("/change-password", authMiddleware, c.changePassword)

module.exports = router
