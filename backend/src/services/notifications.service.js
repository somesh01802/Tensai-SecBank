const { getDb, schema } = require("../db")

const WELCOME = [
    { title: "Welcome to Tensai SecBank!", body: "Your account is ready. Start by exploring your dashboard.", category: "WELCOME", severity: "SUCCESS", actionUrl: "/app" },
    { title: "Rewards await you", body: "Complete tasks around the app to earn reward points.", category: "REWARDS", severity: "INFO", actionUrl: "/app/rewards" },
    { title: "Personal loans at 10.99% p.a.", body: "Pre-approved offer for you. Zero paperwork, instant disbursal.", category: "LOANS", severity: "INFO", actionUrl: "/app/loans" },
    { title: "FD rates revised", body: "Tensai Fixed Deposits now up to 7.35% p.a.", category: "OFFERS", severity: "INFO", actionUrl: "/app/investments" },
    { title: "Enable AutoPay on your SIPs", body: "Automate your monthly contributions.", category: "INVESTMENTS", severity: "INFO", actionUrl: "/app/investments" },
    { title: "Try our Sapphire Credit Card", body: "10X rewards on all spends. See if you qualify.", category: "CARDS", severity: "INFO", actionUrl: "/app/cards" },
    { title: "Set up recurring bills", body: "Never miss a bill again. Enable AutoPay for utilities.", category: "BILLS", severity: "INFO", actionUrl: "/app/bills" },
    { title: "Add your first payee", body: "Send money faster by saving payees.", category: "TRANSFERS", severity: "INFO", actionUrl: "/app/transfer" },
    { title: "Security tip", body: "Never share your MPIN or CVV with anyone.", category: "SECURITY", severity: "WARNING", actionUrl: null },
    { title: "Home loan @ 8.60% onwards", body: "Balance transfer with processing fee waived.", category: "LOANS", severity: "INFO", actionUrl: "/app/loans" }
]

async function seedWelcomeNotifications(userId) {
    const db = await getDb()
    const rows = WELCOME.map((n) => ({ userId, ...n }))
    await db.insert(schema.notifications).values(rows)
}

module.exports = { seedWelcomeNotifications }
