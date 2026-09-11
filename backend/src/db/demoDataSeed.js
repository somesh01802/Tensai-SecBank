const { getDb, schema } = require("./index")

/**
 * Seeds realistic demo dashboard data for a freshly-registered user so the
 * dashboard doesn't look empty on first visit.
 *
 * Called from the auth controller right after registration succeeds.
 */
async function seedDemoDataForUser(userId, userName) {
    const db = await getDb()

    // Investments
    await db.insert(schema.investments).values([
        {
            userId,
            type: "MUTUAL_FUND",
            name: "Mutual funds",
            investedAmount: "30000.00",
            currentValue: "35000.00",
            monthlyContribution: "5000.00",
            returnPct: "7.21",
            frequencyLabel: "5,000 / month"
        },
        {
            userId,
            type: "LIFE_INSURANCE",
            name: "Life insurance",
            investedAmount: "700000.00",
            currentValue: "700000.00",
            monthlyContribution: "3200.00",
            frequencyLabel: "3200 / month"
        },
        {
            userId,
            type: "FIXED_DEPOSIT",
            name: "Fixed Deposit",
            investedAmount: "150000.00",
            currentValue: "156000.00",
            monthlyContribution: "12000.00",
            returnPct: "6.00",
            frequencyLabel: "12000 / month"
        },
        {
            userId,
            type: "STOCKS",
            name: "Stocks",
            investedAmount: "45000.00",
            currentValue: "49500.00",
            returnPct: "10.00",
            frequencyLabel: "invested amount · Rs. 45000"
        }
    ])

    // Cards: intentionally NOT auto-issued.
    // New users start with zero cards and must apply for one from Cards page.
    // See Dashboard's card widget: shows a promotional advert until the user
    // has an active card.

    // Bills — a mix of due items for the dashboard right rail
    const today = new Date()
    await db.insert(schema.bills).values([
        {
            userId,
            billerName: "Phone recharge",
            category: "PHONE",
            iconHint: "airtel",
            amount: "599.00",
            dueDate: addDays(today, 3),
            status: "DUE"
        },
        {
            userId,
            billerName: "Credit card bill",
            category: "CREDIT_CARD",
            iconHint: "cc",
            amount: "12779.12",
            dueDate: addDays(today, 5),
            status: "DUE"
        },
        {
            userId,
            billerName: "EMI",
            category: "EMI",
            iconHint: "percent",
            amount: "8989.00",
            dueDate: addDays(today, 8),
            status: "DUE"
        },
        {
            userId,
            billerName: "Netflix",
            category: "STREAMING",
            iconHint: "netflix",
            amount: "299.00",
            dueDate: addDays(today, 10),
            status: "DUE"
        }
    ])
}

function randomDigits(n) {
    let s = ""
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
    return s
}
function addDays(d, days) {
    const r = new Date(d)
    r.setDate(r.getDate() + days)
    return r
}

module.exports = { seedDemoDataForUser }
