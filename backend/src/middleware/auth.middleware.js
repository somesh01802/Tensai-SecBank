const jwt = require("jsonwebtoken")
const { eq } = require("drizzle-orm")
const { getDb, schema } = require("../db")

async function authMiddleware(req, res, next) {
    const token = req.cookies.token || req.headers.authorization?.split(" ")[1]

    if (!token) {
        return res.status(401).json({ message: "Unauthorized: token is missing" })
    }

    try {
        const db = await getDb()

        const revoked = await db
            .select()
            .from(schema.revokedTokens)
            .where(eq(schema.revokedTokens.token, token))
            .limit(1)

        if (revoked.length) {
            return res.status(401).json({ message: "Unauthorized: token is revoked" })
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        const rows = await db
            .select({
                id: schema.users.id,
                email: schema.users.email,
                name: schema.users.name,
                systemUser: schema.users.systemUser
            })
            .from(schema.users)
            .where(eq(schema.users.id, decoded.userId))
            .limit(1)

        if (rows.length === 0) {
            return res.status(401).json({ message: "Unauthorized: user not found" })
        }

        req.user = rows[0]
        req.token = token
        return next()
    } catch (err) {
        return res.status(401).json({ message: "Unauthorized: token is invalid" })
    }
}

async function authSystemUserMiddleware(req, res, next) {
    return authMiddleware(req, res, () => {
        if (!req.user?.systemUser) {
            return res.status(403).json({ message: "Forbidden: system user required" })
        }
        return next()
    })
}

module.exports = { authMiddleware, authSystemUserMiddleware }
