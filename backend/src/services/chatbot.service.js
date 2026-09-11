/**
 * Tensai SecBank AI assistant.
 *
 * Design:
 *   - Server owns the LLM call. Client only sends the user's turn.
 *   - Before calling the LLM, we assemble a *sanitized* snapshot of the user's
 *     own data (accounts, loans, cards, bills, rewards, recent transactions).
 *   - We redact anything the model must never see:
 *       - MPIN hashes / raw MPIN
 *       - Full card numbers (only last 4)
 *       - CVV
 *       - JWTs, password hashes
 *       - Other users' rows (context is user-scoped by user_id)
 *   - Configuration lives in ENV: ANTHROPIC_API_KEY, ANTHROPIC_MODEL.
 *   - If ANTHROPIC_API_KEY is unset, we fall back to a deterministic
 *     rule-based responder built off the sanitized snapshot, so the bot
 *     still works end-to-end without an external dependency.
 */

const { and, eq, desc, sql } = require("drizzle-orm")
const { getDb, schema } = require("../db")

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"
const MAX_HISTORY = 8

const SYSTEM_PROMPT_TEMPLATE = `You are Tensai SecBank's in-app AI banking assistant.

RULES
1. Only answer questions about this app or the CURRENT user's own accounts,
   balances, loans, cards, bills, rewards, transfers, and history.
2. Never invent numbers. If a specific figure is not in the context below,
   say you don't have that information rather than guessing.
3. Never execute financial transactions, close accounts, apply for loans,
   change MPINs, or share sensitive credentials. If the user asks you to,
   direct them to the appropriate page inside the app.
4. Refuse to reveal or infer the MPIN, password, full card number, CVV, or
   auth tokens under any circumstances.
5. Keep answers concise (2-5 sentences unless the user explicitly asks for
   detail). Use plain English + Indian rupee formatting.
6. If the user asks about another person's account or unrelated topics
   (politics, medical advice, coding, etc.), politely decline and redirect
   to banking questions.

USER CONTEXT (sanitized snapshot from PostgreSQL)
{{CONTEXT_JSON}}
`

/**
 * Assemble a compact, secure user snapshot for the LLM.
 * Every field here is safe to send to a third-party LLM.
 */
async function buildUserContext(userId) {
    const db = await getDb()

    const [users, accounts, txs, loans, cards, bills, autopays, recBills, rewardsRow] = await Promise.all([
        db.select({
            name: schema.users.name,
            email: schema.users.email,
            mobileNumber: schema.users.mobileNumber,
            createdAt: schema.users.createdAt
        }).from(schema.users).where(eq(schema.users.id, userId)).limit(1),

        db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),

        db.select().from(schema.transactions).orderBy(desc(schema.transactions.createdAt)).limit(10),

        db.select().from(schema.loanApplications).where(eq(schema.loanApplications.userId, userId)),

        db.select().from(schema.cards).where(eq(schema.cards.userId, userId)),

        db.select().from(schema.bills).where(eq(schema.bills.userId, userId)),

        db.select().from(schema.investmentAutopay).where(eq(schema.investmentAutopay.userId, userId)),

        db.select().from(schema.recurringBills).where(eq(schema.recurringBills.userId, userId)),

        db.select({
            totalPoints: sql`COALESCE(SUM(${schema.userRewardTasks.pointsAwarded}), 0)`.as("totalPoints"),
            completedCount: sql`COUNT(*)`.as("completedCount")
        }).from(schema.userRewardTasks).where(eq(schema.userRewardTasks.userId, userId))
    ])

    const acctIds = new Set(accounts.map((a) => a.id))

    // Balance per account via a single aggregate. We build a literal IN list
    // because PGlite's OTLP-Wire adapter doesn't bind postgres array params.
    const balances = new Map()
    if (accounts.length) {
        const idList = accounts.map((a) => `'${a.id.replace(/'/g, "''")}'`).join(", ")
        const balRows = await db.$rawQuery(`
            SELECT account_id, COALESCE(SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END), 0) AS balance
            FROM ledger_entries
            WHERE account_id IN (${idList})
            GROUP BY account_id
        `)
        const rows = balRows?.rows || balRows || []
        for (const r of rows) balances.set(r.account_id, Number(r.balance))
    }

    const user = users[0] || {}
    const sanitizedAccounts = accounts.map((a) => ({
        id: a.id,
        kind: a.kind,
        displayName: a.displayName,
        accountNumber: a.accountNumber ? "xxxxxx" + a.accountNumber.slice(-4) : null,
        status: a.status,
        isPrimary: a.isPrimary === true,
        balance: balances.get(a.id) ?? 0,
        currency: a.currency,
        openedOn: a.createdAt
    }))

    const sanitizedTxs = txs
        .filter((t) => acctIds.has(t.fromAccountId) || acctIds.has(t.toAccountId))
        .slice(0, 8)
        .map((t) => ({
            id: t.id.slice(0, 8),
            amount: Number(t.amount),
            direction: acctIds.has(t.fromAccountId) && !acctIds.has(t.toAccountId) ? "OUT"
                : acctIds.has(t.toAccountId) && !acctIds.has(t.fromAccountId) ? "IN"
                : t.category === "WELCOME_BONUS" || t.category === "DEPOSIT" ? "IN"
                : t.fromAccountId === t.toAccountId ? "OUT" : "OUT",
            description: t.description,
            category: t.category,
            status: t.status,
            createdAt: t.createdAt
        }))

    const sanitizedLoans = loans.map((l) => ({
        id: l.id.slice(0, 8),
        productId: l.productId,
        principal: Number(l.principal),
        interestRate: Number(l.interestRate),
        tenureMonths: l.tenureMonths,
        emi: Number(l.emi),
        totalInterest: Number(l.totalInterest),
        totalRepayment: Number(l.totalRepayment),
        status: l.status,
        appliedOn: l.createdAt,
        closedOn: l.closedAt
    }))

    // Cards — deliberately DROP full_number and cvv.
    const sanitizedCards = cards
        .filter((c) => !c.deletedAt)
        .map((c) => ({
            id: c.id.slice(0, 8),
            type: c.type,
            brand: c.brand,
            lastFour: c.lastFour,
            expiry: `${String(c.expiryMonth).padStart(2, "0")}/${String(c.expiryYear).padStart(2, "0")}`,
            holderName: c.holderName,
            isFrozen: c.isFrozen === true
        }))

    const sanitizedBills = bills.map((b) => ({
        id: b.id.slice(0, 8),
        billerName: b.billerName,
        category: b.category,
        amount: Number(b.amount),
        dueDate: b.dueDate,
        status: b.status
    }))

    const sanitizedAutopay = autopays.map((a) => ({
        id: a.id.slice(0, 8),
        investmentId: a.investmentId.slice(0, 8),
        amount: Number(a.amount),
        frequency: a.frequency,
        nextRunAt: a.nextRunAt,
        enabled: a.enabled === true
    }))

    const sanitizedRecBills = recBills.map((r) => ({
        id: r.id.slice(0, 8),
        billerName: r.billerName,
        amount: Number(r.amount),
        frequency: r.frequency,
        nextRunAt: r.nextRunAt,
        autopayEnabled: r.autopayEnabled === true,
        enabled: r.enabled === true
    }))

    const totalBalance = sanitizedAccounts.reduce((s, a) => s + a.balance, 0)
    const primary = sanitizedAccounts.find((a) => a.isPrimary) || sanitizedAccounts[0] || null

    return {
        user: {
            name: user.name,
            email: user.email,
            mobileMasked: user.mobileNumber ? `xxxxxx${String(user.mobileNumber).slice(-4)}` : null,
            memberSince: user.createdAt
        },
        totals: {
            balance: totalBalance,
            currency: "INR",
            accountCount: sanitizedAccounts.length,
            openLoanCount: sanitizedLoans.filter((l) => l.status !== "CLOSED" && l.status !== "REJECTED").length,
            activeCardCount: sanitizedCards.filter((c) => !c.isFrozen).length,
            unpaidBillCount: sanitizedBills.filter((b) => b.status !== "PAID").length
        },
        primaryAccount: primary,
        accounts: sanitizedAccounts,
        recentTransactions: sanitizedTxs,
        loans: sanitizedLoans,
        cards: sanitizedCards,
        bills: sanitizedBills,
        autopays: sanitizedAutopay,
        recurringBills: sanitizedRecBills,
        rewards: {
            totalPoints: Number(rewardsRow[0]?.totalPoints ?? 0),
            completedCount: Number(rewardsRow[0]?.completedCount ?? 0)
        },
        appFeatures: {
            supportedActions: [
                "Send money (Transfer > Quick Fund Transfer)",
                "Receive money (Dashboard > Receive Money)",
                "Move funds between own accounts (Manage Account > Internal Transfer)",
                "Apply for loans (Loans page)",
                "Apply for a new card (Cards page)",
                "Add payees & schedule transfers (Transfer page)",
                "Pay bills / set up recurring bills (Bills page)",
                "Investment AutoPay (Investments page)",
                "Download statement (Transactions > Download Statement)",
                "Change name/email or password (Settings)"
            ]
        }
    }
}

/**
 * Format a currency value in Indian style, safe for LLM prompts.
 */
function inr(v) {
    return "₹ " + new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(Number(v) || 0)
}

/**
 * Attempt to answer without an LLM using a small rule-based responder over
 * the sanitized snapshot. This lets the chatbot ship even when
 * ANTHROPIC_API_KEY is unset. Returns { text, source } or null.
 */
function tryRuleBasedAnswer(userMessage, ctx) {
    const q = (userMessage || "").toLowerCase()
    const has = (...kws) => kws.some((k) => q.includes(k))

    if (has("hi", "hello", "hey", "namaste") && q.length < 40) {
        return {
            text: `Hi ${ctx.user.name?.split(" ")[0] || "there"}! I can help with questions about your Tensai SecBank accounts, balances, transactions, loans, cards, bills, and rewards. What would you like to know?`
        }
    }

    if (has("balance", "how much", "money", "funds")) {
        const primary = ctx.primaryAccount
        const lines = [
            `Your total balance across ${ctx.totals.accountCount} account(s) is ${inr(ctx.totals.balance)}.`
        ]
        if (primary) {
            lines.push(`Primary ${primary.kind || "Savings"} (${primary.accountNumber || "…"}): ${inr(primary.balance)}.`)
        }
        return { text: lines.join(" ") }
    }

    if (has("card") && has("cvv", "full number", "secret")) {
        return { text: "For your safety I can never share your CVV or full card number. You can reveal them yourself inside Cards → tap the eye icon on any card." }
    }

    if (has("card")) {
        if (ctx.cards.length === 0) return { text: "You don't have any active cards yet. You can apply for one from the Cards page." }
        const summary = ctx.cards.map((c) => `${c.type === "CREDIT" ? "Credit" : "Debit"} card ending in ${c.lastFour}${c.isFrozen ? " (frozen)" : ""}`).join(", ")
        return { text: `You currently have ${ctx.cards.length} card(s): ${summary}.` }
    }

    if (has("loan")) {
        if (ctx.loans.length === 0) return { text: "You don't have any loan applications yet. You can apply from the Loans page." }
        const active = ctx.loans.filter((l) => l.status !== "CLOSED" && l.status !== "REJECTED")
        const l = active[0] || ctx.loans[0]
        return {
            text: `You have ${ctx.loans.length} loan application(s), ${active.length} still active. Latest: principal ${inr(l.principal)} at ${l.interestRate}% p.a. for ${l.tenureMonths} months, monthly EMI ${inr(l.emi)}, status ${l.status}.`
        }
    }

    if (has("bill")) {
        const unpaid = ctx.bills.filter((b) => b.status !== "PAID")
        if (unpaid.length === 0) return { text: "You're all caught up — no unpaid bills right now. Nicely done." }
        const totalDue = unpaid.reduce((s, b) => s + b.amount, 0)
        const next = unpaid[0]
        return { text: `You have ${unpaid.length} unpaid bill(s) totalling ${inr(totalDue)}. Next one: ${next.billerName} for ${inr(next.amount)}.` }
    }

    if (has("reward", "point")) {
        return { text: `You have ${ctx.rewards.totalPoints} reward points across ${ctx.rewards.completedCount} completed tasks. Open Rewards to see what else you can earn.` }
    }

    if (has("last transaction", "recent transaction", "recent tx", "last transfer")) {
        const t = ctx.recentTransactions[0]
        if (!t) return { text: "No transactions on your account yet." }
        return { text: `Your most recent transaction was ${t.direction === "IN" ? "a credit" : "a debit"} of ${inr(t.amount)}${t.description ? " — " + t.description : ""} on ${new Date(t.createdAt).toLocaleDateString("en-IN")}.` }
    }

    if (has("mpin", "pin", "password")) {
        return { text: "I can't ever share or change your MPIN or password. You can change your password from Settings, and reset your MPIN by contacting support." }
    }

    if (has("send money", "transfer") && has("how", "help")) {
        return { text: "You can send money via Transfer → Quick Fund Transfer (external bank), or move funds between your own accounts via Manage Account → Internal Transfer. To save a recipient, use Transfer → Add New Payee." }
    }

    if (has("receive")) {
        return { text: "Use Dashboard → Receive Money to record a deposit into your primary account. Enter the amount, an optional source and remarks, then confirm." }
    }

    if (has("statement", "download", "csv")) {
        return { text: "Open Transactions, pick a date range (1 Day / 1 Week / 1 Month / Custom), then click Download Statement to save a CSV." }
    }

    if (has("open account", "new account")) {
        return { text: "Go to Manage Account → Open Account. You can choose Savings, Salary, NRI, Business, or Investment. Fill in your name, PAN, PIN code, occupation, and mobile, then Apply Now." }
    }

    if (has("who", "what") && has("you", "bot", "assistant")) {
        return { text: "I'm Tensai SecBank's in-app assistant. I can only help with questions about this app and your own accounts. Try asking about your balance, cards, loans, bills, or rewards." }
    }

    return null
}

/**
 * Call the Claude API. Returns { text } or throws.
 */
async function callClaude({ systemPrompt, messages }) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set")

    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 400,
            system: systemPrompt,
            messages
        })
    })
    if (!res.ok) {
        const errText = await res.text().catch(() => "")
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = await res.json()
    const text = (data?.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim()
    return { text: text || "(no reply)" }
}

/**
 * Public entry point.
 *   ask({ userId, message, history }) → { text, source, contextSummary }
 */
async function ask({ userId, message, history = [] }) {
    if (!message || typeof message !== "string" || !message.trim()) {
        return { text: "Ask me anything about your Tensai SecBank account.", source: "guard" }
    }
    if (message.length > 2000) {
        return { text: "Please shorten your question (under 2000 characters).", source: "guard" }
    }

    const ctx = await buildUserContext(userId)

    // Truncate + shape history
    const trimmedHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY) : []
    const messages = trimmedHistory
        .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
    messages.push({ role: "user", content: message })

    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
        "{{CONTEXT_JSON}}",
        JSON.stringify(ctx, null, 2).slice(0, 12_000)
    )

    // Prefer LLM when configured
    if (process.env.ANTHROPIC_API_KEY) {
        try {
            const out = await callClaude({ systemPrompt, messages })
            return { text: out.text, source: "llm" }
        } catch (err) {
            // Fall through to rule-based
            console.warn("[chatbot] LLM call failed, falling back:", err.message)
        }
    }

    const ruled = tryRuleBasedAnswer(message, ctx)
    if (ruled) return { text: ruled.text, source: "rules" }

    return {
        text: "I'm running in offline mode right now. I can answer questions about your balance, cards, loans, bills, transfers, rewards, and how to use Tensai SecBank features. Try asking one of those.",
        source: "rules-fallback"
    }
}

module.exports = { ask, buildUserContext }
