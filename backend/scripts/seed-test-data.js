#!/usr/bin/env node
/**
 * Synthetic test-data seeder for Tensai SecBank.
 *
 * Generates N synthetic users (default 5000) that can log in through the real
 * app (email+password OR mobile+MPIN), each with realistic banking data and a
 * mix of successful + failed transactions covering the standard failure
 * scenarios. All records are tagged synthetic. Emits OpenTelemetry spans +
 * metrics + logs for a sampled fraction of transactions so Kibana has
 * queryable success/failure data.
 *
 * SAFE: never logs passwords/MPINs; writes a gitignored credential manifest.
 * IDEMPOTENT: users are keyed by a deterministic email; rerun skips existing.
 *
 * Config (env):
 *   DATABASE_URL            required (postgres://... or pglite://...)
 *   SEED_USERS=5000         how many synthetic users
 *   SEED_TX_PER_USER=8      transactions per user (success + failure mix)
 *   SEED_PREFIX=tuser       email/identifier namespace -> <prefix>00001@tensai.test
 *   SEED_BCRYPT_ROUNDS=10   bcrypt cost (10 = app default; lower only for speed)
 *   SEED_EMIT_OTEL=true     emit OTEL for sampled transactions
 *   SEED_OTEL_SAMPLE=0.05   fraction of transactions exported as spans
 *   SEED_MANIFEST=scripts/out/test-credentials.json   output path (gitignored)
 *
 * Usage:
 *   node scripts/seed-test-data.js
 *   SEED_USERS=20 node scripts/seed-test-data.js      # quick validation
 */

const path = require("path")
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true })
require("../src/telemetry") // init OTEL SDK first

const fs = require("fs")
const bcrypt = require("bcryptjs")
const { sql } = require("drizzle-orm")
const { getDb, schema, closeDb, runMigrations } = require("../src/db")
const { seedCatalog } = require("../src/db/catalogSeed")
const { getTelemetry } = require("../src/telemetry")

/* ----------------------------- config ----------------------------- */
const N          = int(process.env.SEED_USERS, 5000)
const TX_PER     = int(process.env.SEED_TX_PER_USER, 8)
const PREFIX     = process.env.SEED_PREFIX || "tuser"
const ROUNDS     = int(process.env.SEED_BCRYPT_ROUNDS, 10)
const EMIT_OTEL  = process.env.SEED_EMIT_OTEL !== "false"
const OTEL_SAMPLE= num(process.env.SEED_OTEL_SAMPLE, 0.05)
const MANIFEST   = path.join(__dirname, "..", (process.env.SEED_MANIFEST || "scripts/out/test-credentials.json").replace(/^backend\//, ""))
const PAD        = String(N).length

/* --------------------------- generators --------------------------- */
const FIRST = "James Mary John Patricia Robert Jennifer Michael Linda William Elizabeth David Barbara Richard Susan Joseph Jessica Thomas Karen Charles Sarah Chris Nancy Daniel Lisa Matthew Betty Anthony Sandra Mark Ashley Ava Noah Mia Liam Zoe Ethan Nora Ian Priya Raj Aisha Omar Wei Ling Diego Sofia Yuki Hana".split(" ")
const LAST  = "Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez White Harris Clark Lewis Young King Wright Hill Patel Khan Chen Nguyen Kumar Mehta Ali Costa Rossi Sato".split(" ")
const BANKS = ["Chase", "Bank of America", "Wells Fargo", "Citibank", "US Bank", "PNC Bank", "Capital One", "TD Bank", "Truist", "Tensai SecBank"]
const BILLERS = [["Verizon", "PHONE"], ["Comcast", "INTERNET"], ["Netflix", "STREAMING"], ["ConEd", "ELECTRICITY"], ["Spotify", "STREAMING"], ["AmEx", "CREDIT_CARD"], ["Geico", "INSURANCE"]]
const INV_TYPES = [["MUTUAL_FUND", "Vanguard 500"], ["FIXED_DEPOSIT", "12-mo CD"], ["STOCKS", "Blue-chip stocks"], ["LIFE_INSURANCE", "Term life"], ["RECURRING_DEPOSIT", "Monthly RD"]]
const CARD_COLORS = ["sky", "violet", "emerald", "peach"]

// Failure scenarios: [errorCategory, failureReason, weight]
const FAILURES = [
    ["CORE_TIMEOUT", "legacy core banking timeout", 3],
    ["API_FAILURE", "api/middleware failure", 3],
    ["FRAUD_TIMEOUT", "fraud-engine evaluation timeout", 2],
    ["DB_DEADLOCK", "database deadlock detected", 2],
    ["NETWORK_LATENCY", "upstream network latency exceeded", 2],
    ["OTP_DELAY", "otp/mfa delivery delay", 2],
    ["DISTRIBUTED_INCONSISTENCY", "distributed-service inconsistency, rolled back", 2],
    ["PROCESSOR_OUTAGE", "third-party processor outage", 2],
    ["INFRA_FAILURE", "load-balancer / infrastructure failure", 1],
    ["INSUFFICIENT_FUNDS", "insufficient funds", 3],
    ["INVALID_ACCOUNT", "invalid destination account details", 2],
    ["LIMIT_EXCEEDED", "transfer-limit violation", 2],
    ["EXPIRED_CARD", "expired card attempt", 1]
]
const FAIL_BAG = FAILURES.flatMap(([c, r, w]) => Array(w).fill([c, r]))

const rnd  = (a, b) => a + Math.random() * (b - a)
const rint = (a, b) => Math.floor(rnd(a, b + 1))
const pick = (arr) => arr[rint(0, arr.length - 1)]
const digits = (n) => Array.from({ length: n }, () => rint(0, 9)).join("")
const money = (v) => Number(v).toFixed(2)
const daysAgo = (d) => new Date(Date.now() - d * 86400_000)

/* ------------------------------ main ------------------------------ */
async function main() {
    const started = Date.now()
    if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set")
    console.log(`[seed] users=${N} tx/user=${TX_PER} rounds=${ROUNDS} otel=${EMIT_OTEL}(sample ${OTEL_SAMPLE})`)

    const db = await getDb()
    await runMigrations()          // idempotent; safe against an already-migrated prod DB
    await seedCatalog()            // loan/card products + reward tasks (ON CONFLICT DO NOTHING)

    const cardProducts = (await db.select().from(schema.cardProducts))
    const loanProducts = (await db.select().from(schema.loanProducts))
    const rewardTasks  = (await db.select().from(schema.rewardTasks))

    // Idempotency: load already-seeded emails in one query.
    const existing = await db.execute(sql`SELECT email FROM users WHERE email LIKE ${PREFIX + "%@tensai.test"}`)
    const seen = new Set((existing.rows || existing).map((r) => r.email))

    const tele = getTelemetry?.()
    const manifest = []
    let created = 0, skipped = 0, txOk = 0, txFail = 0

    for (let i = 1; i <= N; i++) {
        const email = `${PREFIX}${String(i).padStart(PAD, "0")}@tensai.test`
        if (seen.has(email)) { skipped++; continue }

        const r = await seedOneUser({ db, i, email, cardProducts, loanProducts, rewardTasks, tele })
        manifest.push(r.credentials)
        created++; txOk += r.txOk; txFail += r.txFail

        if (created % 250 === 0) console.log(`[seed] created=${created} skipped=${skipped} tx(ok=${txOk} fail=${txFail}) t=${sec(started)}s`)
    }

    writeManifest(manifest)
    console.log(`[seed] done: created=${created} skipped=${skipped} tx(ok=${txOk} fail=${txFail}) in ${sec(started)}s`)

    if (created > 0) await selfCheck(db)

    if (tele?.shutdown) { console.log("[seed] flushing telemetry..."); await tele.shutdown() }
    await closeDb()
}

async function seedOneUser({ db, i, email, cardProducts, loanProducts, rewardTasks, tele }) {
    const name = `${pick(FIRST)} ${pick(LAST)}`
    const mobile = String(8_900_000_000 + i) // 10 digits, unique per index, synthetic range
    const password = `Seed-${i}-${digits(4)}`
    const mpin = digits(6)
    const [passwordHash, mpinHash] = await Promise.all([
        bcrypt.hash(password, ROUNDS),
        bcrypt.hash(mpin, ROUNDS)
    ])

    // user + mpin
    const [user] = await db.insert(schema.users).values({
        email, name, passwordHash, mobileNumber: mobile,
        pan: ("AAAAA" + digits(4) + "A").toUpperCase(),
        occupation: pick(["Engineer", "Teacher", "Doctor", "Analyst", "Designer", "Nurse", "Manager"]),
        pinCode: digits(6)
    }).returning({ id: schema.users.id })
    await db.insert(schema.mpinCredentials).values({ userId: user.id, mpinHash })

    // primary account + opening balance (self-credit, keeps ledger consistent)
    const primaryNo = String(8_900_000_000 + i * 2)
    const [primary] = await db.insert(schema.accounts).values({
        userId: user.id, accountNumber: primaryNo, kind: "SAVINGS",
        displayName: "Primary Savings", isPrimary: true, currency: "USD"
    }).returning({ id: schema.accounts.id })
    await openingDeposit(db, primary.id, money(rnd(2000, 60000)))

    // ~55% get a secondary account
    let secondary = null
    if (Math.random() < 0.55) {
        const kind = pick(["SALARY", "BUSINESS", "INVESTMENT"])
        const [s] = await db.insert(schema.accounts).values({
            userId: user.id, accountNumber: String(8_900_000_000 + i * 2 + 1),
            kind, displayName: `${cap(kind)} Account`, currency: "USD"
        }).returning({ id: schema.accounts.id })
        secondary = s.id
        await openingDeposit(db, secondary, money(rnd(500, 20000)))
    }

    // cards 0..2
    if (cardProducts.length) for (let c = rint(0, 2); c > 0; c--) {
        const p = pick(cardProducts)
        await db.insert(schema.cards).values({
            userId: user.id, holderName: name, lastFour: digits(4),
            fullNumber: "4" + digits(15), cvv: digits(3),
            expiryMonth: rint(1, 12), expiryYear: (new Date().getFullYear() + rint(2, 5)) % 100,
            type: p.cardType, brand: p.network || "MASTERCARD", network: p.network || "MASTERCARD",
            colorHint: pick(CARD_COLORS), productId: p.id, accountId: primary.id
        })
    }

    // bills 2..4
    for (let b = rint(2, 4); b > 0; b--) {
        const [biller, category] = pick(BILLERS)
        await db.insert(schema.bills).values({
            userId: user.id, billerName: biller, category,
            amount: money(rnd(15, 900)), dueDate: daysAgo(-rint(1, 20)),
            status: Math.random() < 0.3 ? "PAID" : "DUE"
        })
    }

    // investments 1..4
    for (let v = rint(1, 4); v > 0; v--) {
        const [type, nm] = pick(INV_TYPES)
        const invested = rnd(1000, 50000)
        await db.insert(schema.investments).values({
            userId: user.id, type, name: nm,
            investedAmount: money(invested), currentValue: money(invested * rnd(0.9, 1.25)),
            monthlyContribution: money(rnd(50, 1000)), returnPct: money(rnd(-5, 15)),
            frequencyLabel: "monthly"
        })
    }

    // payees 1..3
    for (let p = rint(1, 3); p > 0; p--) {
        await db.insert(schema.payees).values({
            userId: user.id, bankName: pick(BANKS), accountNumber: digits(rint(10, 14)),
            accountHolderName: `${pick(FIRST)} ${pick(LAST)}`, nickname: pick(["Mom", "Landlord", "Friend", "Vendor", "Savings"])
        })
    }

    // beneficiary -> own secondary account (valid FK, unique per (user, account))
    if (secondary) await db.insert(schema.beneficiaries).values({
        userId: user.id, toAccountId: secondary, nickname: "My other account"
    }).onConflictDoNothing()

    // ~40% get a loan application
    if (loanProducts.length && Math.random() < 0.4) {
        const lp = pick(loanProducts)
        const principal = rnd(Number(lp.minAmount), Math.min(Number(lp.maxAmount), 200000))
        const tenure = rint(lp.minTenure, lp.maxTenure)
        const rate = Number(lp.interestRate)
        const { emi, totalInterest, totalRepayment } = computeLoan(principal, rate, tenure)
        await db.insert(schema.loanApplications).values({
            userId: user.id, productId: lp.id, principal: money(principal), tenureMonths: tenure,
            interestRate: money(rate), emi: money(emi), totalInterest: money(totalInterest),
            totalRepayment: money(totalRepayment), status: pick(["PENDING", "APPROVED", "DISBURSED"])
        })
    }

    // rewards: award a random subset
    if (rewardTasks.length) {
        const awarded = shuffle(rewardTasks).slice(0, rint(3, 15))
        for (const task of awarded) {
            await db.insert(schema.userRewardTasks).values({
                userId: user.id, taskId: task.id, pointsAwarded: task.points
            }).onConflictDoNothing()
        }
    }

    // a welcome notification so the bell isn't empty
    await db.insert(schema.notifications).values({
        userId: user.id, title: "Welcome to Tensai SecBank",
        body: "Your synthetic test account is ready.", category: "WELCOME", severity: "INFO"
    })

    // transactions: success + failure mix
    let txOk = 0, txFail = 0
    for (let k = 0; k < TX_PER; k++) {
        const when = daysAgo(rnd(0, 30))
        const res = Math.random() < 0.62
            ? await successTx({ db, i, k, userId: user.id, primary: primary.id, secondary, primaryNo, when })
            : await failureTx({ db, i, k, userId: user.id, primary: primary.id, secondary, primaryNo, when })
        res.ok ? txOk++ : txFail++
        if (EMIT_OTEL && tele?.recordTransaction && Math.random() < OTEL_SAMPLE) {
            tele.recordTransaction(res.telemetry)
        }
    }

    return {
        txOk, txFail,
        credentials: { userId: user.id, identifier: email, email, mobileNumber: mobile, password, mpin }
    }
}

/* ----------------------- transaction builders ---------------------- */

// Opening deposit: self-credit transaction + one CREDIT ledger entry.
async function openingDeposit(db, accountId, amount) {
    const [tx] = await db.insert(schema.transactions).values({
        fromAccountId: accountId, toAccountId: accountId, amount, status: "COMPLETED",
        idempotencyKey: `seed-open-${accountId}`, description: "[SYNTHETIC] opening balance",
        category: "WELCOME_BONUS"
    }).returning({ id: schema.transactions.id })
    await db.insert(schema.ledgerEntries).values({ accountId, transactionId: tx.id, type: "CREDIT", amount })
}

// Successful tx: internal transfer (if secondary) or a deposit. Writes balanced ledger.
async function successTx({ db, i, k, userId, primary, secondary, primaryNo, when }) {
    const amount = money(rnd(10, 1500))
    const key = `seed-tx-${i}-${k}-${digits(6)}`
    const doTransfer = secondary && Math.random() < 0.6
    const fromId = primary
    const toId = doTransfer ? secondary : primary
    const op = doTransfer ? "transfer.internal" : "deposit"

    const [tx] = await db.insert(schema.transactions).values({
        fromAccountId: fromId, toAccountId: toId, amount, status: "COMPLETED",
        idempotencyKey: key, description: `[SYNTHETIC] ${op}`, category: doTransfer ? "TRANSFER" : "DEPOSIT",
        createdAt: when, updatedAt: when
    }).returning({ id: schema.transactions.id })

    if (doTransfer) {
        await db.insert(schema.ledgerEntries).values([
            { accountId: fromId, transactionId: tx.id, type: "DEBIT", amount },
            { accountId: toId, transactionId: tx.id, type: "CREDIT", amount }
        ])
    } else {
        await db.insert(schema.ledgerEntries).values({ accountId: toId, transactionId: tx.id, type: "CREDIT", amount })
    }

    return {
        ok: true,
        telemetry: {
            transactionId: tx.id, userId, operation: op, synthetic: true,
            fromLast4: primaryNo.slice(-4), toLast4: primaryNo.slice(-4),
            amount: Number(amount), currency: "USD", outcome: "SUCCESS", status: "COMPLETED",
            endpoint: "seed", durationMs: rint(40, 900), startTimeMs: when.getTime()
        }
    }
}

// Failed tx: FAILED row, NO ledger entries -> balance untouched (ledger integrity).
async function failureTx({ db, i, k, userId, primary, secondary, primaryNo, when }) {
    const [category, reason] = pick(FAIL_BAG)
    const amount = money(rnd(10, 5000))
    const key = `seed-fail-${i}-${k}-${digits(6)}`
    const toId = secondary || primary

    const [tx] = await db.insert(schema.transactions).values({
        fromAccountId: primary, toAccountId: toId, amount, status: "FAILED",
        idempotencyKey: key, description: `[SYNTHETIC] FAILED: ${reason}`, category,
        createdAt: when, updatedAt: when
    }).returning({ id: schema.transactions.id })

    return {
        ok: false,
        telemetry: {
            transactionId: tx.id, userId, operation: "transfer.internal", synthetic: true,
            fromLast4: primaryNo.slice(-4), toLast4: primaryNo.slice(-4),
            amount: Number(amount), currency: "USD", outcome: "FAILURE", status: "FAILED",
            errorCategory: category, failureReason: reason,
            endpoint: "seed", durationMs: rint(50, 3000), startTimeMs: when.getTime()
        }
    }
}

/* ------------------------------ checks ----------------------------- */
async function selfCheck(db) {
    // 1. No FAILED transaction may have ledger entries.
    const badFailed = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM ledger_entries le
        JOIN transactions t ON t.id = le.transaction_id WHERE t.status = 'FAILED'`)
    const n1 = Number((badFailed.rows || badFailed)[0].n)

    // 2. Every COMPLETED 2-sided transfer must have equal debit & credit.
    const unbalanced = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM (
          SELECT transaction_id,
                 SUM(CASE WHEN type='DEBIT' THEN amount ELSE 0 END) AS d,
                 SUM(CASE WHEN type='CREDIT' THEN amount ELSE 0 END) AS c,
                 COUNT(*) AS entries
          FROM ledger_entries GROUP BY transaction_id
        ) x WHERE entries = 2 AND d <> c`)
    const n2 = Number((unbalanced.rows || unbalanced)[0].n)

    // 3. No account may hold a negative balance.
    const negative = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM (
          SELECT account_id, SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END) AS bal
          FROM ledger_entries GROUP BY account_id
        ) y WHERE bal < 0`)
    const n3 = Number((negative.rows || negative)[0].n)

    console.log(`[seed] self-check: failed-with-ledger=${n1} unbalanced-transfers=${n2} negative-balances=${n3}`)
    if (n1 !== 0 || n2 !== 0 || n3 !== 0) fail(`ledger integrity violated (${n1}/${n2}/${n3})`)
    console.log("[seed] self-check OK: ledger integrity preserved")
}

/* ------------------------------ utils ------------------------------ */
function writeManifest(rows) {
    if (!rows.length) { console.log("[seed] no new users -> manifest unchanged"); return }
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true })
    // Merge with any existing manifest so reruns accumulate.
    let prev = []
    try { prev = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) } catch { /* none */ }
    const byId = new Map(prev.map((r) => [r.userId, r]))
    for (const r of rows) byId.set(r.userId, r)
    fs.writeFileSync(MANIFEST, JSON.stringify([...byId.values()], null, 2), { mode: 0o600 })
    try { fs.chmodSync(MANIFEST, 0o600) } catch { /* windows */ }
    console.log(`[seed] credential manifest -> ${MANIFEST} (${byId.size} users) [DO NOT COMMIT]`)
}

function computeLoan(principal, annualRatePct, months) {
    const r = annualRatePct / 100 / 12
    const emi = r === 0 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
    const totalRepayment = emi * months
    return { emi, totalInterest: totalRepayment - principal, totalRepayment }
}
function shuffle(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = rint(0, i);[b[i], b[j]] = [b[j], b[i]] } return b }
function cap(s) { return s[0] + s.slice(1).toLowerCase() }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d }
function sec(t) { return ((Date.now() - t) / 1000).toFixed(1) }
function fail(msg) { console.error("[seed] FATAL:", msg); process.exit(1) }

main().catch((e) => { console.error("[seed] crashed:", e); process.exit(1) })
