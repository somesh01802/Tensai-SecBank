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

const SYSTEM_PROMPT_TEMPLATE = `You are Nexus, Tensai SecBank's in-app AI banking assistant.

STYLE
- Sound warm, calm, confident. Answers stay concise (2-6 sentences).
- Use INR formatting (₹ 1,00,000.00). No emojis in body text.
- When explaining how to do something inside the app, give clear step-by-step
  instructions naming the exact page, tab, button, and required fields
  from the "APP FLOWS" section below.

HARD RULES
1. Only answer questions about this app or the CURRENT user's own accounts,
   balances, loans, cards, bills, rewards, transfers, and history.
2. Never invent numbers. If a specific figure is not in the USER CONTEXT
   below, say you don't have that information rather than guessing.
3. Never execute financial transactions, close accounts, apply for loans,
   change MPINs, or share sensitive credentials. Guide the user to do those
   from the appropriate page.
4. Never reveal or infer the MPIN, password, full card number, CVV, or
   auth tokens. If asked, politely refuse and point to the eye-icon inside
   the Cards page for card reveal (that path is authorized in-app).
5. Only describe features that actually exist in APP FLOWS below. Do not
   invent additional flows.
6. If the user asks about another person's account or unrelated topics,
   politely decline and redirect to banking questions.

APP FLOWS (the ONLY features that exist inside this app)
- Apply for a card:
    Sidebar → Cards → New Debit Card or New Credit Card →
    pick a tier (Everyday / Lifestyle / Premium) → pick a specific product →
    fill Mobile Number, PAN (AAAAA9999A), Date of Birth → Submit application.
    A card is issued instantly and appears in the Cards page.
- Apply for a loan:
    Sidebar → Loans → pick a product (Home / Car / Personal / Education /
    Gold / Business) → Apply Now → set Amount + Tenure (months) → review the
    server-calculated EMI + Total Interest + Total Repayment → Apply Loan.
- Send money externally (to another bank):
    Sidebar → Transfer → Quick Fund Transfer tab → pick Bank, enter
    Account Number + Confirm Account Number, Account Holder Name, Amount,
    optional Remarks, choose Source account → Review → Transfer.
- Add a payee / beneficiary:
    Sidebar → Transfer → Add New Payee tab → pick Bank, enter Account Number +
    Confirm Account Number (must match), Account Holder Name, Nickname → Save.
    Payees appear in the Manage Payees tab.
- Move money between own accounts (internal transfer):
    Sidebar → Manage Account → Internal Transfer tab → pick From + To accounts
    (must differ) → Amount + optional Remarks → Review → Transfer.
- Receive money (demo deposit into primary account):
    Dashboard → Receive money button → Amount + optional Source + Remarks →
    Review → Credit account.
- Open a new account:
    Sidebar → Manage Account → Open Account tab → pick Savings / Salary /
    NRI / Business / Investment → fill Name, PAN, PIN code, Occupation,
    Mobile + type-specific fields → Apply Now. A 10-digit account number
    is generated on approval.
- Close an account:
    Sidebar → Manage Account → click the account → Close account button.
    Primary account cannot be closed. Non-zero balance must be moved first.
- Pay a bill:
    Sidebar → Bills → One-time tab → Pay now on the bill row. The primary
    account is debited via the ledger.
- Set up a recurring bill:
    Sidebar → Bills → Recurring tab → enter Biller, Category, Amount (or
    enable Auto-detect), Frequency, Source account, Next date, keep AutoPay
    enabled → Create.
- Schedule a transfer:
    Sidebar → Transfer → Schedule Transfer tab → pick Payee, Amount,
    optional Remarks, Date + Time, Frequency, Source account → Schedule.
- Enable investment AutoPay:
    Sidebar → Investments → click Set up AutoPay on a holding → pick
    Source account + Amount + Frequency + Next run at → Enable.
- Freeze or cancel a card:
    Sidebar → Cards → click Freeze on a card (or the trash icon to cancel).
- Reveal card number + CVV:
    Sidebar → Cards → click Reveal on the card. The user authorises the
    reveal themselves; Nexus never reveals it.
- Download a statement:
    Sidebar → Transactions → pick a date range (1 Day / 1 Week / 1 Month /
    Custom) → Download Statement (CSV).
- Change name / email:
    Sidebar → Settings → Profile section → Save changes.
- Change password:
    Sidebar → Settings → Change password section.
- Set / reset MPIN:
    MPIN is set once after registration. To reset, contact support.
- View rewards:
    Sidebar → Rewards. Complete tasks around the app to earn points.
- View / clear notifications:
    Top bar bell icon (right of the search bar).
- Mask / unmask balance:
    Dashboard → eye icon next to "Account balance".
- Change theme:
    Top bar sun/moon icon.

USER CONTEXT (sanitized snapshot from PostgreSQL — never fabricate figures)
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
    const asksHow = has("how", "steps", "guide", "walk me", "help me")

    // Bare greetings: match "hi", "hello", "hey", "namaste", "yo" as
    // stand-alone words at the start of a short message.
    if (/^\s*(hi|hello|hey|namaste|yo|hola|hii+|hey there|good (morning|afternoon|evening))\b/i.test(userMessage || "") && q.length < 60) {
        return {
            text: `Hi ${ctx.user.name?.split(" ")[0] || "there"}! I'm Nexus. I can walk you through anything in the app — applying for a card, sending money, adding a payee, setting up a loan — and answer questions about your own accounts, balances, cards, loans, bills, and rewards. What would you like to do?`
        }
    }

    /* -------------------- Step-by-step "how-to" flows -------------------- */

    if ((asksHow || has("apply", "get", "start")) && has("credit card", "debit card") ||
        (has("card") && asksHow && has("apply", "get"))) {
        const type = has("debit") ? "Debit" : "Credit"
        return { text:
`To apply for a ${type} Card:
1. Open the sidebar → Cards.
2. Click "New ${type} Card".
3. Pick a tier: Everyday, Lifestyle, or Premium.
4. Choose a specific product to see its benefits + annual fee.
5. Fill in Mobile Number, PAN (AAAAA9999A format), and Date of Birth.
6. Submit the application — your card is issued instantly and appears in Cards.

You can then reveal the number & CVV, freeze it, or cancel it from that page.`
        }
    }

    if (asksHow && (has("loan", "borrow", "emi"))) {
        return { text:
`To apply for a loan:
1. Sidebar → Loans.
2. Pick a product (Home, Car, Personal, Education, Gold, or Business).
3. Click "Apply Now".
4. Enter Amount and Tenure (in months). Nexus/backend calculates EMI, Total Interest, and Total Repayment live.
5. Review the repayment summary, then click "Apply Loan".

Your application appears at the bottom of the Loans page. You can open any loan to see the schedule or close/cancel it.`
        }
    }

    // Schedule transfer must come BEFORE the generic transfer-money rule.
    if (asksHow && (has("schedule transfer", "schedule a transfer", "scheduled transfer", "future transfer", "recurring transfer"))) {
        return { text:
`To schedule a transfer:
1. Sidebar → Transfer → "Schedule Transfer" tab.
2. Pick a Payee (add one first if needed).
3. Enter Amount and optional Remarks.
4. Pick Date and Time, Frequency, and Source account.
5. Click "Schedule".

The backend scheduler runs it at the chosen time. You can pause or cancel it from the same page.`
        }
    }

    if (asksHow && (has("transfer money", "send money", "send funds", "wire", "transfer to"))) {
        return { text:
`To send money to another bank:
1. Sidebar → Transfer → "Quick Fund Transfer" tab.
2. Pick a Bank.
3. Enter Account Number, then Confirm Account Number (they must match).
4. Enter Account Holder Name, Amount, and optional Remarks.
5. Pick your Source account.
6. Click "Review" → confirm → "Transfer".

Tip: to move money between your own Tensai SecBank accounts, use Manage Account → Internal Transfer instead.`
        }
    }

    if (asksHow && (has("payee", "beneficiary"))) {
        return { text:
`To add a payee:
1. Sidebar → Transfer → "Add New Payee" tab.
2. Pick the recipient's Bank.
3. Enter Account Number and Confirm Account Number (must match).
4. Enter Account Holder Name and a friendly Nickname.
5. Click "Save payee".

You can view, activate/deactivate, or delete saved payees from the "Manage Payees" tab.`
        }
    }

    if (asksHow && (has("internal transfer", "own account", "between my account", "move funds"))) {
        return { text:
`To move funds between your own accounts:
1. Sidebar → Manage Account → "Internal Transfer" tab.
2. Pick From account and To account (they must differ).
3. Enter Amount and optional Remarks.
4. Click "Review Transfer" → "Transfer".

The debit and credit happen atomically inside a PostgreSQL transaction, so balances stay consistent.`
        }
    }

    if (asksHow && (has("receive money", "deposit"))) {
        return { text:
`To receive money (demo deposit into your primary account):
1. Dashboard → click "Receive money".
2. Enter Amount, optional Source and Remarks.
3. Click "Review" → "Credit account".

The amount is credited to your primary account instantly and appears in Transactions.`
        }
    }

    if (asksHow && (has("open account", "new account", "add account", "open a savings", "open a salary", "open a nri", "open a business", "open an investment", "open savings", "open salary", "open nri", "open business", "open investment"))) {
        return { text:
`To open a new account:
1. Sidebar → Manage Account → "Open Account" tab.
2. Pick a type: Savings, Salary, NRI, Business, or Investment.
3. Fill Name, PAN, PIN code, Occupation, Mobile number, plus any type-specific fields.
4. Click "Apply Now".

The account is approved instantly and a fresh 10-digit account number is generated.`
        }
    }

    if (asksHow && (has("close account", "close my account", "close an account", "delete account", "delete my account", "cancel account", "cancel my account", "shut account", "shut my account"))) {
        return { text:
`To close an account:
1. Sidebar → Manage Account → click the account card to open its details.
2. Click "Close account".

Note: your primary account can't be closed, and any non-zero balance must be moved out first (use Internal Transfer). The account keeps its history — status becomes CLOSED.`
        }
    }

    if (asksHow && (has("pay bill", "pay a bill", "bill payment"))) {
        return { text:
`To pay a bill:
1. Sidebar → Bills → "One-time" tab.
2. On the bill row, click "Pay now". The primary account is debited via a real ledger transaction.

For repeating bills, use the "Recurring" tab to create one with AutoPay + optional auto-detect amount.`
        }
    }

    if (asksHow && (has("recurring", "auto pay", "autopay") && has("bill", "utility"))) {
        return { text:
`To set up a recurring bill:
1. Sidebar → Bills → "Recurring" tab.
2. Enter Biller name, Category, and Amount (or tick "Auto-detect amount" to fetch it from the demo provider).
3. Pick a Frequency, Source account, Next payment date/time.
4. Keep "Enable AutoPay" ticked so the scheduler pays it for you.
5. Click "Create".`
        }
    }

    if (asksHow && (has("investment", "sip") && has("autopay", "auto pay", "recurring"))) {
        return { text:
`To enable AutoPay for an investment:
1. Sidebar → Investments.
2. Click "Set up AutoPay" on the holding you want.
3. Pick a Source account, enter Amount, pick a Frequency and Next run at.
4. Click "Enable".

The scheduler debits your source account on schedule and increases the holding's invested amount.`
        }
    }

    if (asksHow && (has("freeze") && has("card"))) {
        return { text:
`To freeze a card:
1. Sidebar → Cards.
2. On the card, click "Freeze".

Frozen cards stop working for new charges instantly. Click "Unfreeze" to re-enable it, or the trash icon to cancel the card entirely.`
        }
    }

    if (asksHow && (has("reveal") && has("card"))) {
        return { text:
`To reveal your full card number and CVV:
1. Sidebar → Cards.
2. On the card, click the "Reveal" (eye) button.

Nexus itself never reveals card details — you authorise the reveal yourself, in-app, so it stays secure.`
        }
    }

    if (asksHow && (has("statement", "download") || has("csv"))) {
        return { text:
`To download a statement:
1. Sidebar → Transactions.
2. Pick a date range: 1 Day, 1 Week, 1 Month, All time, or Custom (start + end date).
3. Click "Download Statement".

You'll get a CSV built from the actual filtered transactions with Date, Reference, Description, Category, Debit, Credit, Balance, and Status.`
        }
    }

    if (asksHow && (has("change password", "change my password", "reset password", "reset my password", "update password", "update my password", "new password"))) {
        return { text:
`To change your password:
1. Sidebar → Settings.
2. In the "Change password" card, enter your current password and a new one (at least 6 characters).
3. Click "Change password".`
        }
    }

    if (asksHow && (has("change name") || has("update profile") || has("change email"))) {
        return { text:
`To update your profile:
1. Sidebar → Settings.
2. Edit your Full name and/or Email in the Profile card.
3. Click "Save changes".`
        }
    }

    if (asksHow && has("mask") && has("balance")) {
        return { text:
`Your balance is masked by default on the Dashboard. Click the eye icon next to "Account balance:" to reveal it, and click again to mask it.`
        }
    }

    if (asksHow && has("notification")) {
        return { text:
`To read your notifications, click the bell icon at the top-right of the header. From the dropdown you can mark items read, mark all read, or open the full Notifications page.`
        }
    }

    if (asksHow && (has("dark mode", "theme"))) {
        return { text:
`To toggle dark mode, click the sun/moon icon at the top of the header.`
        }
    }

    /* --------------------- Account / data lookups --------------------- */

    if (has("balance", "how much", "how much money", "funds")) {
        const primary = ctx.primaryAccount
        const lines = [
            `Your total balance across ${ctx.totals.accountCount} account(s) is ${inr(ctx.totals.balance)}.`
        ]
        if (primary) {
            lines.push(`Primary ${primary.kind || "Savings"} (${primary.accountNumber || "…"}): ${inr(primary.balance)}.`)
        }
        return { text: lines.join(" ") }
    }

    // Sensitive-disclosure refusal — triggers regardless of whether the
    // question also mentions "card".
    if (has("cvv", "full card number", "card number", "full number", "card secret")) {
        return { text: "For your safety I can never share your CVV or full card number. You can reveal them yourself inside Cards → tap the Reveal (eye) button on any card. That path is authorised in-app and stays private to you." }
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

    // Sensitive-credential refusal: only trigger when the user is asking us
    // to *reveal* / *tell* / *share* the value. "How do I change" style
    // questions are handled by the "change password" how-to above.
    if ((has("mpin", "password")) && has("what is", "what's my", "tell me", "share", "reveal", "show me")) {
        return { text: "I can never share your MPIN or password — even to you. You can change your password from Settings → Change password. If you've forgotten your MPIN, please contact support." }
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
