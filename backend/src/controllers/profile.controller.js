const bcrypt = require("bcryptjs")
const { eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")

function isValidEmail(email) {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)
}

/**
 * GET /api/profile
 */
async function getProfile(req, res) {
    return res.status(200).json({
        profile: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name
        }
    })
}

/**
 * PATCH /api/profile
 * body: { name?, email? }
 */
async function updateProfile(req, res) {
    const { name, email } = req.body
    const patch = {}
    if (typeof name === "string" && name.trim().length > 0) patch.name = name.trim()
    if (typeof email === "string" && email.trim().length > 0) {
        if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email address" })
        patch.email = email.toLowerCase()
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ message: "No changes" })
    patch.updatedAt = new Date()

    const db = await getDb()
    try {
        const [row] = await db
            .update(schema.users)
            .set(patch)
            .where(eq(schema.users.id, req.user.id))
            .returning({
                id: schema.users.id,
                email: schema.users.email,
                name: schema.users.name
            })
        return res.status(200).json({ profile: row })
    } catch (err) {
        if (String(err.message || "").includes("users_email_unique")) {
            return res.status(409).json({ message: "Email already in use" })
        }
        console.error("[profile] update failed:", err)
        return res.status(500).json({ message: "Could not update profile" })
    }
}

/**
 * POST /api/profile/change-password
 * body: { currentPassword, newPassword }
 */
async function changePassword(req, res) {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "currentPassword and newPassword are required" })
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters" })
    }

    const db = await getDb()
    const rows = await db
        .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, req.user.id))
        .limit(1)

    if (rows.length === 0) return res.status(404).json({ message: "User not found" })

    const ok = await bcrypt.compare(currentPassword, rows[0].passwordHash)
    if (!ok) return res.status(401).json({ message: "Current password is incorrect" })

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await db
        .update(schema.users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.users.id, req.user.id))

    return res.status(200).json({ message: "Password changed" })
}

module.exports = { getProfile, updateProfile, changePassword }
