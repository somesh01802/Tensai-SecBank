const express = require("express")
const authController = require("../controllers/auth.controller")
const { authMiddleware } = require("../middleware/auth.middleware")

const router = express.Router()

router.post("/register", authController.userRegisterController)
router.post("/login", authController.userLoginController)
router.post("/logout", authController.userLogoutController)
router.get("/me", authMiddleware, authController.getCurrentUserController)
router.get("/mpin", authMiddleware, authController.hasMpinController)
router.post("/mpin", authMiddleware, authController.setMpinController)

module.exports = router
