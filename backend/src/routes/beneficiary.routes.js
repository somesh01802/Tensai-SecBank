const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const c = require("../controllers/beneficiary.controller")

const router = express.Router()

router.get("/", authMiddleware, c.listBeneficiaries)
router.post("/", authMiddleware, c.createBeneficiary)
router.delete("/:id", authMiddleware, c.deleteBeneficiary)

module.exports = router
