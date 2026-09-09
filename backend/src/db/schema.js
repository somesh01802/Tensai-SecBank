const {
    pgTable,
    uuid,
    text,
    varchar,
    boolean,
    timestamp,
    date,
    integer,
    numeric,
    index,
    uniqueIndex,
    jsonb,
    pgEnum
} = require("drizzle-orm/pg-core")

/**
 * ENUMS
 */
const accountStatus = pgEnum("account_status", ["ACTIVE", "FROZEN", "CLOSED"])
const transactionStatus = pgEnum("transaction_status", [
    "PENDING",
    "COMPLETED",
    "FAILED",
    "REVERSED"
])
const ledgerType = pgEnum("ledger_type", ["DEBIT", "CREDIT"])
const investmentType = pgEnum("investment_type", [
    "MUTUAL_FUND",
    "LIFE_INSURANCE",
    "FIXED_DEPOSIT",
    "STOCKS",
    "RECURRING_DEPOSIT"
])
const cardType = pgEnum("card_type", ["CREDIT", "DEBIT"])
const billStatus = pgEnum("bill_status", ["DUE", "PAID", "OVERDUE"])

/**
 * USERS
 * - passwordHash is stored bcrypt
 */
const users = pgTable(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        email: text("email").notNull(),
        name: text("name").notNull(),
        passwordHash: text("password_hash").notNull(),
        systemUser: boolean("is_system_user").notNull().default(false),
        mobileNumber: varchar("mobile_number", { length: 10 }),
        pan: varchar("pan", { length: 10 }),
        dob: date("dob"),
        occupation: text("occupation"),
        pinCode: varchar("pin_code", { length: 6 }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        emailUnique: uniqueIndex("users_email_unique").on(t.email)
    })
)

const mpinCredentials = pgTable("mpin_credentials", {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    mpinHash: text("mpin_hash").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

const accountKind = pgEnum("account_kind", [
    "SAVINGS", "SALARY", "NRI", "BUSINESS", "INVESTMENT", "SYSTEM"
])

/**
 * ACCOUNTS
 */
const accounts = pgTable(
    "accounts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        currency: varchar("currency", { length: 3 }).notNull().default("INR"),
        status: accountStatus("status").notNull().default("ACTIVE"),
        accountNumber: varchar("account_number", { length: 12 }),
        kind: accountKind("kind").notNull().default("SAVINGS"),
        displayName: text("display_name"),
        isPrimary: boolean("is_primary").notNull().default(false),
        closedAt: timestamp("closed_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        userIdx: index("accounts_user_idx").on(t.userId),
        userStatusIdx: index("accounts_user_status_idx").on(t.userId, t.status)
    })
)

/**
 * TRANSACTIONS
 * - amount is stored as numeric to avoid float issues
 * - idempotencyKey is globally unique
 */
const transactions = pgTable(
    "transactions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        fromAccountId: uuid("from_account_id")
            .notNull()
            .references(() => accounts.id, { onDelete: "restrict" }),
        toAccountId: uuid("to_account_id")
            .notNull()
            .references(() => accounts.id, { onDelete: "restrict" }),
        amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
        status: transactionStatus("status").notNull().default("PENDING"),
        idempotencyKey: text("idempotency_key").notNull(),
        description: text("description"),
        category: text("category"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        idemUnique: uniqueIndex("transactions_idempotency_key_unique").on(t.idempotencyKey),
        fromIdx: index("transactions_from_idx").on(t.fromAccountId),
        toIdx: index("transactions_to_idx").on(t.toAccountId)
    })
)

/**
 * LEDGER
 * - Immutable at the application layer (no update endpoints).
 * - Every transaction produces one DEBIT + one CREDIT entry.
 * - balance = SUM(credit) - SUM(debit) for the account.
 */
const ledgerEntries = pgTable(
    "ledger_entries",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        accountId: uuid("account_id")
            .notNull()
            .references(() => accounts.id, { onDelete: "restrict" }),
        transactionId: uuid("transaction_id")
            .notNull()
            .references(() => transactions.id, { onDelete: "restrict" }),
        type: ledgerType("type").notNull(),
        amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        accountIdx: index("ledger_account_idx").on(t.accountId),
        txIdx: index("ledger_transaction_idx").on(t.transactionId)
    })
)

/**
 * BENEFICIARIES
 * - Saved payees a user can transfer to without pasting an account ID.
 */
const beneficiaries = pgTable(
    "beneficiaries",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        toAccountId: uuid("to_account_id")
            .notNull()
            .references(() => accounts.id, { onDelete: "restrict" }),
        nickname: text("nickname").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        userIdx: index("beneficiaries_user_idx").on(t.userId),
        userAccountUnique: uniqueIndex("beneficiaries_user_account_unique").on(
            t.userId,
            t.toAccountId
        )
    })
)

/**
 * REVOKED_TOKENS
 * - JWTs that were logged out.
 * - Cleaned up periodically (expiresAt is JWT's exp).
 */
const revokedTokens = pgTable(
    "revoked_tokens",
    {
        token: text("token").primaryKey(),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
    },
    (t) => ({
        expiresIdx: index("revoked_tokens_expires_idx").on(t.expiresAt)
    })
)

/**
 * INVESTMENTS — holdings (MF, LI, FD, Stocks, RD).
 */
const investments = pgTable(
    "investments",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        type: investmentType("type").notNull(),
        name: text("name").notNull(),
        investedAmount: numeric("invested_amount", { precision: 20, scale: 2 })
            .notNull()
            .default("0"),
        currentValue: numeric("current_value", { precision: 20, scale: 2 })
            .notNull()
            .default("0"),
        monthlyContribution: numeric("monthly_contribution", { precision: 20, scale: 2 }),
        returnPct: numeric("return_pct", { precision: 8, scale: 2 }),
        frequencyLabel: text("frequency_label"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        userIdx: index("investments_user_idx").on(t.userId)
    })
)

/**
 * CARDS — payment cards owned by a user.
 */
const cards = pgTable(
    "cards",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        accountId: uuid("account_id").references(() => accounts.id, {
            onDelete: "set null"
        }),
        holderName: text("holder_name").notNull(),
        lastFour: varchar("last_four", { length: 4 }).notNull(),
        expiryMonth: integer("expiry_month").notNull(),
        expiryYear: integer("expiry_year").notNull(),
        type: cardType("type").notNull(),
        brand: text("brand").notNull().default("MASTERCARD"),
        colorHint: text("color_hint").notNull().default("peach"),
        isFrozen: boolean("is_frozen").notNull().default(false),
        productId: uuid("product_id"),
        fullNumber: varchar("full_number", { length: 16 }),
        cvv: varchar("cvv", { length: 3 }),
        network: text("network").notNull().default("MASTERCARD"),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        userIdx: index("cards_user_idx").on(t.userId)
    })
)

/**
 * BILLS — payables tracked in the app.
 */
const bills = pgTable(
    "bills",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        billerName: text("biller_name").notNull(),
        category: text("category").notNull(),
        iconHint: text("icon_hint"),
        amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
        dueDate: timestamp("due_date", { withTimezone: true, mode: "date" }),
        status: billStatus("status").notNull().default("DUE"),
        paidAt: timestamp("paid_at", { withTimezone: true }),
        paidTxId: uuid("paid_tx_id").references(() => transactions.id, {
            onDelete: "set null"
        }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => ({
        userIdx: index("bills_user_idx").on(t.userId),
        statusIdx: index("bills_status_idx").on(t.status)
    })
)

/* ============================================================ */
/*  v2 tables                                                    */
/* ============================================================ */

const applicationStatus = pgEnum("application_status", [
    "PENDING", "APPROVED", "REJECTED"
])

const notificationSeverity = pgEnum("notification_severity", [
    "INFO", "SUCCESS", "WARNING", "ALERT"
])

const loanStatus = pgEnum("loan_status", [
    "PENDING", "APPROVED", "REJECTED", "DISBURSED", "CLOSED"
])

const frequency = pgEnum("frequency", [
    "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY", "ONCE"
])

const scheduledTransferStatus = pgEnum("scheduled_transfer_status", [
    "SCHEDULED", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"
])

const accountApplications = pgTable("account_applications", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: accountKind("kind").notNull(),
    applicantName: text("applicant_name").notNull(),
    pan: varchar("pan", { length: 10 }).notNull(),
    pinCode: varchar("pin_code", { length: 6 }).notNull(),
    occupation: text("occupation").notNull(),
    mobileNumber: varchar("mobile_number", { length: 10 }).notNull(),
    extra: jsonb("extra").notNull().default({}),
    status: applicationStatus("status").notNull().default("APPROVED"),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true })
})

const notifications = pgTable("notifications", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull(),
    severity: notificationSeverity("severity").notNull().default("INFO"),
    readAt: timestamp("read_at", { withTimezone: true }),
    actionUrl: text("action_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
})

const loanProducts = pgTable("loan_products", {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    interestRate: numeric("interest_rate", { precision: 6, scale: 3 }).notNull(),
    minAmount: numeric("min_amount", { precision: 20, scale: 2 }).notNull(),
    maxAmount: numeric("max_amount", { precision: 20, scale: 2 }).notNull(),
    minTenure: integer("min_tenure").notNull(),
    maxTenure: integer("max_tenure").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
})

const loanApplications = pgTable("loan_applications", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => loanProducts.id, { onDelete: "restrict" }),
    principal: numeric("principal", { precision: 20, scale: 2 }).notNull(),
    tenureMonths: integer("tenure_months").notNull(),
    interestRate: numeric("interest_rate", { precision: 6, scale: 3 }).notNull(),
    emi: numeric("emi", { precision: 20, scale: 2 }).notNull(),
    totalInterest: numeric("total_interest", { precision: 20, scale: 2 }).notNull(),
    totalRepayment: numeric("total_repayment", { precision: 20, scale: 2 }).notNull(),
    status: loanStatus("status").notNull().default("PENDING"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

const investmentAutopay = pgTable("investment_autopay", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    investmentId: uuid("investment_id").notNull().references(() => investments.id, { onDelete: "cascade" }),
    sourceAccountId: uuid("source_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    frequency: frequency("frequency").notNull().default("MONTHLY"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

const investmentAutopayRuns = pgTable("investment_autopay_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    autopayId: uuid("autopay_id").notNull().references(() => investmentAutopay.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    status: text("status").notNull(),
    transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    reason: text("reason"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow()
})

const cardProducts = pgTable("card_products", {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    category: text("category").notNull(),
    cardType: cardType("card_type").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    benefits: jsonb("benefits").notNull().default([]),
    annualFee: numeric("annual_fee", { precision: 20, scale: 2 }).notNull().default("0"),
    colorHint: text("color_hint").notNull().default("peach"),
    network: text("network").notNull().default("MASTERCARD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
})

const cardApplications = pgTable("card_applications", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => cardProducts.id, { onDelete: "restrict" }),
    mobileNumber: varchar("mobile_number", { length: 10 }).notNull(),
    pan: varchar("pan", { length: 10 }).notNull(),
    dob: date("dob").notNull(),
    status: applicationStatus("status").notNull().default("APPROVED"),
    cardId: uuid("card_id").references(() => cards.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true })
})

const recurringBills = pgTable("recurring_bills", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    billerName: text("biller_name").notNull(),
    category: text("category").notNull(),
    providerHint: text("provider_hint"),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    autoDetectAmount: boolean("auto_detect_amount").notNull().default(false),
    frequency: frequency("frequency").notNull().default("MONTHLY"),
    sourceAccountId: uuid("source_account_id").references(() => accounts.id, { onDelete: "set null" }),
    autopayEnabled: boolean("autopay_enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

const recurringBillRuns = pgTable("recurring_bill_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    recurringBillId: uuid("recurring_bill_id").notNull().references(() => recurringBills.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    billId: uuid("bill_id").references(() => bills.id, { onDelete: "set null" }),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow()
})

const payees = pgTable("payees", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    bankName: text("bank_name").notNull(),
    accountNumber: varchar("account_number", { length: 20 }).notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    nickname: text("nickname").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

const scheduledTransfers = pgTable("scheduled_transfers", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    payeeId: uuid("payee_id").notNull().references(() => payees.id, { onDelete: "restrict" }),
    sourceAccountId: uuid("source_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    remarks: text("remarks"),
    frequency: frequency("frequency").notNull().default("ONCE"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    status: scheduledTransferStatus("status").notNull().default("SCHEDULED"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
})

const scheduledTransferRuns = pgTable("scheduled_transfer_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduledTransferId: uuid("scheduled_transfer_id").notNull().references(() => scheduledTransfers.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow()
})

const rewardTasks = pgTable("reward_tasks", {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    points: integer("points").notNull(),
    completionCondition: text("completion_condition").notNull(),
    category: text("category").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
})

const userRewardTasks = pgTable("user_reward_tasks", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => rewardTasks.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    pointsAwarded: integer("points_awarded").notNull()
})

const auditLogs = pgTable("audit_logs", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    entity: text("entity"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
})

module.exports = {
    users,
    mpinCredentials,
    accounts,
    transactions,
    ledgerEntries,
    beneficiaries,
    revokedTokens,
    investments,
    cards,
    bills,
    accountStatus,
    transactionStatus,
    ledgerType,
    investmentType,
    cardType,
    billStatus,
    accountKind,
    applicationStatus,
    notificationSeverity,
    loanStatus,
    frequency,
    scheduledTransferStatus,
    accountApplications,
    notifications,
    loanProducts,
    loanApplications,
    investmentAutopay,
    investmentAutopayRuns,
    cardProducts,
    cardApplications,
    recurringBills,
    recurringBillRuns,
    payees,
    scheduledTransfers,
    scheduledTransferRuns,
    rewardTasks,
    userRewardTasks,
    auditLogs
}
