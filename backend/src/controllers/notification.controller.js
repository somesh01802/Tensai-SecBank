const { and, eq, desc, isNull, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const rewards = require("../services/rewards.service")

async function list(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, req.user.id))
        .orderBy(desc(schema.notifications.createdAt))

    const unread = rows.filter((r) => r.readAt == null).length
    res.status(200).json({ notifications: rows, unreadCount: unread })
}

async function markRead(req, res) {
    const db = await getDb()
    const [row] = await db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(and(
            eq(schema.notifications.id, req.params.id),
            eq(schema.notifications.userId, req.user.id)
        ))
        .returning()
    if (!row) return res.status(404).json({ message: "Notification not found" })

    await rewards.awardByCondition(req.user.id, "notification.read")

    // If user has now read 5+
    const readCount = await db
        .select({ n: sql`COUNT(*)`.as("n") })
        .from(schema.notifications)
        .where(and(
            eq(schema.notifications.userId, req.user.id),
            sql`${schema.notifications.readAt} IS NOT NULL`
        ))
    if (Number(readCount[0]?.n ?? 0) >= 5) {
        await rewards.awardByCondition(req.user.id, "notification.read.count.gte.5")
    }

    res.status(200).json({ notification: row })
}

async function markAllRead(req, res) {
    const db = await getDb()
    await db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(and(
            eq(schema.notifications.userId, req.user.id),
            isNull(schema.notifications.readAt)
        ))
    await rewards.awardByCondition(req.user.id, "notification.all_read")
    res.status(200).json({ message: "All notifications marked read" })
}

module.exports = { list, markRead, markAllRead }
