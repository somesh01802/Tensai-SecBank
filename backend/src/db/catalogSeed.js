/**
 * Seeds the catalog of static data used across the app: loan products,
 * card products, and the 100 reward tasks. Runs at every dev boot; INSERT
 * uses ON CONFLICT so it's idempotent.
 */

const { sql } = require("drizzle-orm")
const { getDb, schema } = require("./index")

async function seedCatalog() {
    const db = await getDb()

    await seedLoanProducts(db)
    await seedCardProducts(db)
    await seedRewardTasks(db)
}

async function seedLoanProducts(db) {
    const products = [
        { code: "HOME", name: "Home Loan", rate: "8.60", min: 500000, max: 50000000, minT: 60, maxT: 360, desc: "Up to 90% funding, balance-transfer offer" },
        { code: "CAR", name: "Car Loan", rate: "9.10", min: 100000, max: 5000000, minT: 12, maxT: 84, desc: "Up to 100% on-road funding" },
        { code: "PERSONAL", name: "Personal Loan", rate: "10.99", min: 50000, max: 4000000, minT: 12, maxT: 60, desc: "Zero paperwork, disburse in minutes" },
        { code: "EDUCATION", name: "Education Loan", rate: "9.85", min: 100000, max: 8000000, minT: 12, maxT: 120, desc: "Study in India or abroad" },
        { code: "GOLD", name: "Gold Loan", rate: "8.85", min: 25000, max: 5000000, minT: 3, maxT: 36, desc: "Loans against gold with same-day disbursal" },
        { code: "BUSINESS", name: "Business Loan", rate: "12.50", min: 100000, max: 20000000, minT: 12, maxT: 60, desc: "Working capital for MSMEs and SMEs" }
    ]
    for (const p of products) {
        await db.$raw(`
            INSERT INTO loan_products (code, name, description, interest_rate, min_amount, max_amount, min_tenure, max_tenure)
            VALUES ('${p.code}', '${p.name.replace(/'/g, "''")}', '${p.desc.replace(/'/g, "''")}', ${p.rate}, ${p.min}, ${p.max}, ${p.minT}, ${p.maxT})
            ON CONFLICT (code) DO NOTHING
        `)
    }
}

async function seedCardProducts(db) {
    const products = [
        // Everyday
        { code: "DEBIT_EVERYDAY", cat: "EVERYDAY", type: "DEBIT", name: "Tensai Everyday Debit", tagline: "Your daily spend, rewarded.", benefits: ["1% cashback on UPI spends","Free ATM withdrawals","Fuel surcharge waiver"], fee: 0, color: "sky" },
        { code: "CREDIT_EVERYDAY", cat: "EVERYDAY", type: "CREDIT", name: "Tensai Everyday Credit", tagline: "Cashback on groceries, fuel, and bills.", benefits: ["5% cashback on groceries","2% on fuel","Bill-pay rewards"], fee: 499, color: "sky" },
        // Lifestyle
        { code: "DEBIT_LIFESTYLE", cat: "LIFESTYLE", type: "DEBIT", name: "Tensai Signature Debit", tagline: "High-end perks for aspirational spenders.", benefits: ["8 airport lounge visits/yr","Concierge helpline","Complimentary movie tickets"], fee: 999, color: "purple" },
        { code: "CREDIT_LIFESTYLE", cat: "LIFESTYLE", type: "CREDIT", name: "Tensai Signature Credit", tagline: "Miles, hotels, and dining privileges.", benefits: ["5X reward miles on travel","20% off on partner hotels","4X on dining"], fee: 2999, color: "purple" },
        // Premium
        { code: "DEBIT_PREMIUM", cat: "PREMIUM", type: "DEBIT", name: "Tensai Sapphire Debit", tagline: "The ultimate premium debit.", benefits: ["Unlimited lounge access","Global concierge","Private-banking priority"], fee: 4999, color: "gold" },
        { code: "CREDIT_PREMIUM", cat: "PREMIUM", type: "CREDIT", name: "Tensai Sapphire Credit", tagline: "Bespoke rewards for the extraordinary.", benefits: ["10X on all spends","Free gold-membership programs","Bespoke offers"], fee: 12999, color: "gold" }
    ]
    for (const p of products) {
        const benefits = JSON.stringify(p.benefits).replace(/'/g, "''")
        await db.$raw(`
            INSERT INTO card_products (code, category, card_type, name, tagline, benefits, annual_fee, color_hint, network)
            VALUES ('${p.code}', '${p.cat}', '${p.type}', '${p.name.replace(/'/g, "''")}', '${p.tagline.replace(/'/g, "''")}', '${benefits}'::jsonb, ${p.fee}, '${p.color}', 'MASTERCARD')
            ON CONFLICT (code) DO NOTHING
        `)
    }
}

async function seedRewardTasks(db) {
    const tasks = buildRewardTasks()
    for (const t of tasks) {
        await db.$raw(`
            INSERT INTO reward_tasks (code, title, description, points, completion_condition, category)
            VALUES ('${t.code}', '${esc(t.title)}', '${esc(t.description)}', ${t.points}, '${esc(t.condition)}', '${t.category}')
            ON CONFLICT (code) DO NOTHING
        `)
    }
}

function esc(s) { return String(s).replace(/'/g, "''") }

function buildRewardTasks() {
    /** 100 distinct in-app tasks users can actually complete. */
    let n = 1
    const t = (title, description, points, condition, category = "GENERAL") => ({
        code: `RT${String(n++).padStart(3, "0")}`,
        title, description, points, condition, category
    })

    const list = [
        // Profile & KYC (10)
        t("Complete your profile", "Fill in your full name, email and mobile number", 50, "profile.name_email_mobile", "PROFILE"),
        t("Add PAN to profile", "Store your PAN for KYC-lite flows", 30, "profile.pan", "PROFILE"),
        t("Add date of birth", "Add DOB to your profile", 20, "profile.dob", "PROFILE"),
        t("Add PIN code", "Save your postal code", 20, "profile.pin_code", "PROFILE"),
        t("Set your occupation", "Tell us what you do", 20, "profile.occupation", "PROFILE"),
        t("Set your MPIN", "Create a 6-digit MPIN for quick login", 40, "mpin.created", "PROFILE"),
        t("Change your password", "Rotate your account password once", 20, "auth.password_changed", "PROFILE"),
        t("Enable dark mode", "Toggle the theme in settings", 10, "preferences.dark_mode", "PROFILE"),
        t("Update your name", "Personalize your Tensai profile", 10, "profile.name_updated", "PROFILE"),
        t("Verify email format", "Save a valid email address", 10, "profile.email_valid", "PROFILE"),

        // Accounts (14)
        t("Open your first account", "Open any Tensai account", 80, "account.opened.any", "ACCOUNT"),
        t("Open a Savings Account", "Apply for a Tensai Savings Account", 60, "account.opened.SAVINGS", "ACCOUNT"),
        t("Open a Salary Account", "Apply for a Tensai Salary Account", 60, "account.opened.SALARY", "ACCOUNT"),
        t("Open a Business Account", "Apply for a Tensai Business Account", 80, "account.opened.BUSINESS", "ACCOUNT"),
        t("Open an NRI Account", "Apply for a Tensai NRI Account", 100, "account.opened.NRI", "ACCOUNT"),
        t("Open an Investment Account", "Apply for a Tensai Investment Account", 80, "account.opened.INVESTMENT", "ACCOUNT"),
        t("Hold 2 accounts", "Have at least 2 accounts", 40, "account.count.gte.2", "ACCOUNT"),
        t("Hold 3 accounts", "Have at least 3 accounts", 60, "account.count.gte.3", "ACCOUNT"),
        t("View account details", "Visit the Manage Account page", 10, "page.visited.manage_account", "ACCOUNT"),
        t("Reveal your balance", "Use the eye control to reveal your balance", 5, "ui.balance.revealed", "ACCOUNT"),
        t("Rename an account", "Set a custom display name for any account", 10, "account.renamed", "ACCOUNT"),
        t("Check total balance", "View your combined balance on the dashboard", 5, "page.visited.dashboard", "ACCOUNT"),
        t("Open account with PIN code", "Provide a valid PIN in your application", 10, "account.pin_code.valid", "ACCOUNT"),
        t("Explore Statistics chart", "Change the statistics range to 1Y", 10, "ui.statistics.1y", "ACCOUNT"),

        // Transfers & Payees (14)
        t("Add your first payee", "Save a payee via Add New Payee", 30, "payee.added.first", "TRANSFER"),
        t("Save 3 payees", "Save at least 3 payees", 60, "payee.count.gte.3", "TRANSFER"),
        t("Send a Quick Fund Transfer", "Complete a quick transfer", 40, "transfer.quick.first", "TRANSFER"),
        t("Send Rs. 500 or more", "Send at least Rs. 500 in one transfer", 20, "transfer.amount.gte.500", "TRANSFER"),
        t("Send Rs. 5000 or more", "Send at least Rs. 5000 in one transfer", 40, "transfer.amount.gte.5000", "TRANSFER"),
        t("Schedule a transfer", "Set up a scheduled transfer", 40, "scheduled_transfer.created", "TRANSFER"),
        t("Complete a scheduled transfer", "Let a scheduled transfer run", 60, "scheduled_transfer.ran", "TRANSFER"),
        t("Cancel a scheduled transfer", "Cancel any scheduled transfer", 10, "scheduled_transfer.cancelled", "TRANSFER"),
        t("Deactivate a payee", "Toggle a payee off", 10, "payee.deactivated", "TRANSFER"),
        t("Reactivate a payee", "Toggle a payee back on", 10, "payee.reactivated", "TRANSFER"),
        t("Delete a payee", "Remove a payee you no longer use", 10, "payee.deleted", "TRANSFER"),
        t("Add a payee with nickname", "Use a friendly nickname when saving", 10, "payee.nickname.custom", "TRANSFER"),
        t("Match account numbers", "Successfully re-enter and match an account number", 5, "payee.acct_match", "TRANSFER"),
        t("Send with remarks", "Add remarks to a transfer", 10, "transfer.remarks", "TRANSFER"),

        // Cards (14)
        t("Apply for your first card", "Apply for any Tensai card", 60, "card.applied.first", "CARD"),
        t("Apply for a Credit Card", "Apply for any Tensai credit card", 40, "card.applied.CREDIT", "CARD"),
        t("Apply for a Debit Card", "Apply for any Tensai debit card", 40, "card.applied.DEBIT", "CARD"),
        t("Apply for an Everyday card", "Pick an Everyday-tier card", 20, "card.applied.EVERYDAY", "CARD"),
        t("Apply for a Lifestyle card", "Pick a Lifestyle-tier card", 40, "card.applied.LIFESTYLE", "CARD"),
        t("Apply for a Premium card", "Pick a Premium-tier card", 80, "card.applied.PREMIUM", "CARD"),
        t("Freeze a card", "Freeze any active card", 15, "card.frozen", "CARD"),
        t("Unfreeze a card", "Unfreeze a frozen card", 10, "card.unfrozen", "CARD"),
        t("Reveal card number", "Reveal your card's full number", 5, "card.number.revealed", "CARD"),
        t("Reveal CVV", "Reveal the CVV of a card", 5, "card.cvv.revealed", "CARD"),
        t("Cancel a card", "Cancel/delete any card", 10, "card.cancelled", "CARD"),
        t("Hold 2 active cards", "Have at least 2 active cards", 30, "card.active.gte.2", "CARD"),
        t("Provide DOB in card app", "Complete DOB in a card application", 10, "card.app.dob", "CARD"),
        t("Provide PAN in card app", "Complete PAN in a card application", 10, "card.app.pan", "CARD"),

        // Loans (10)
        t("Explore loan products", "Visit the Loans page", 10, "page.visited.loans", "LOAN"),
        t("Calculate an EMI", "Use the loan EMI calculator", 15, "loan.emi.calculated", "LOAN"),
        t("Apply for a loan", "Submit any loan application", 60, "loan.applied.first", "LOAN"),
        t("Apply for a Home Loan", "Submit a home loan application", 40, "loan.applied.HOME", "LOAN"),
        t("Apply for a Car Loan", "Submit a car loan application", 40, "loan.applied.CAR", "LOAN"),
        t("Apply for a Personal Loan", "Submit a personal loan application", 30, "loan.applied.PERSONAL", "LOAN"),
        t("Apply for an Education Loan", "Submit an education loan application", 30, "loan.applied.EDUCATION", "LOAN"),
        t("Apply for a Gold Loan", "Submit a gold loan application", 30, "loan.applied.GOLD", "LOAN"),
        t("Apply for a Business Loan", "Submit a business loan application", 50, "loan.applied.BUSINESS", "LOAN"),
        t("Try 3 different tenures", "Preview EMI at 3 different tenures", 10, "loan.tenure.varied", "LOAN"),

        // Investments (10)
        t("View investments", "Visit the Investments page", 10, "page.visited.investments", "INVEST"),
        t("Add an investment", "Record any investment holding", 30, "investment.added", "INVEST"),
        t("Enable investment AutoPay", "Turn on AutoPay for any holding", 40, "autopay.enabled", "INVEST"),
        t("Disable investment AutoPay", "Turn AutoPay off for any holding", 10, "autopay.disabled", "INVEST"),
        t("Run an AutoPay contribution", "Let a scheduled AutoPay execute", 60, "autopay.ran", "INVEST"),
        t("Own a Mutual Fund", "Add a mutual fund", 20, "investment.type.MUTUAL_FUND", "INVEST"),
        t("Own a Fixed Deposit", "Add a fixed deposit", 20, "investment.type.FIXED_DEPOSIT", "INVEST"),
        t("Own Stocks", "Add stocks", 20, "investment.type.STOCKS", "INVEST"),
        t("Own Life Insurance", "Add life insurance", 20, "investment.type.LIFE_INSURANCE", "INVEST"),
        t("Own a Recurring Deposit", "Add a recurring deposit", 20, "investment.type.RECURRING_DEPOSIT", "INVEST"),

        // Bills (10)
        t("View bills", "Visit the Bills page", 10, "page.visited.bills", "BILL"),
        t("Pay a bill", "Pay any bill via Tensai", 40, "bill.paid.first", "BILL"),
        t("Pay 3 bills", "Pay 3 bills total", 80, "bill.paid.count.gte.3", "BILL"),
        t("Add a manual bill", "Add a bill via the form", 15, "bill.added.manual", "BILL"),
        t("Set up a recurring bill", "Create a recurring bill", 40, "recurring_bill.created", "BILL"),
        t("Enable recurring AutoPay", "Turn AutoPay on for a recurring bill", 30, "recurring_bill.autopay_enabled", "BILL"),
        t("Auto-detect a bill amount", "Use the demo auto-detect adapter", 20, "recurring_bill.auto_detect_used", "BILL"),
        t("Complete a recurring run", "Let a recurring bill run", 40, "recurring_bill.ran", "BILL"),
        t("Cancel a bill", "Delete any bill", 10, "bill.deleted", "BILL"),
        t("Cancel a recurring bill", "Delete any recurring bill", 10, "recurring_bill.deleted", "BILL"),

        // Notifications (5)
        t("Open notifications", "View your notification center", 5, "page.visited.notifications", "NOTIFICATION"),
        t("Mark a notification read", "Mark any notification as read", 5, "notification.read", "NOTIFICATION"),
        t("Read 5 notifications", "Mark 5 notifications as read", 20, "notification.read.count.gte.5", "NOTIFICATION"),
        t("Clear all notifications", "Mark every notification as read", 30, "notification.all_read", "NOTIFICATION"),
        t("Follow an in-app link", "Open a notification's action URL", 10, "notification.followed", "NOTIFICATION"),

        // Exploration & Search (8)
        t("Try the search bar", "Use the top search field", 5, "ui.search.used", "EXPLORATION"),
        t("Search for a product", "Search for any bank product", 5, "ui.search.product", "EXPLORATION"),
        t("Visit Rewards", "Open the Rewards page", 5, "page.visited.rewards", "EXPLORATION"),
        t("Visit Transactions", "Open the Transactions page", 5, "page.visited.transactions", "EXPLORATION"),
        t("Visit Overview", "Open the Overview page", 5, "page.visited.overview", "EXPLORATION"),
        t("Visit Cards", "Open the Cards page", 5, "page.visited.cards", "EXPLORATION"),
        t("Visit Investments", "Open the Investments page", 5, "page.visited.investments2", "EXPLORATION"),
        t("Explore all sections", "Visit every sidebar section", 100, "exploration.all_sections", "EXPLORATION"),

        // Milestones (5)
        t("Earn your first 100 points", "Reach 100 total reward points", 25, "milestone.points.100", "MILESTONE"),
        t("Earn 500 points", "Reach 500 total reward points", 50, "milestone.points.500", "MILESTONE"),
        t("Earn 1000 points", "Reach 1000 total reward points", 100, "milestone.points.1000", "MILESTONE"),
        t("Complete 25 tasks", "Finish 25 reward tasks", 50, "milestone.tasks.25", "MILESTONE"),
        t("Complete 50 tasks", "Finish 50 reward tasks", 100, "milestone.tasks.50", "MILESTONE")
    ]
    return list
}

module.exports = { seedCatalog }
