const { and, eq, desc } = require("drizzle-orm")
const { getDb, schema } = require("../db")
const rewards = require("../services/rewards.service")
const { getTelemetry } = require("../telemetry")
const t = () => getTelemetry?.()

/**
 * Standard EMI formula (reducing balance):
 *   EMI = P * r * (1+r)^n / ((1+r)^n - 1)
 * where r = monthly interest rate, n = tenure in months.
 */
function computeEmi(principal, annualRate, tenureMonths) {
    const p = Number(principal)
    const r = Number(annualRate) / 100 / 12
    const n = Number(tenureMonths)
    if (r === 0) return { emi: p / n, totalInterest: 0, totalRepayment: p }
    const factor = Math.pow(1 + r, n)
    const emi = (p * r * factor) / (factor - 1)
    const totalRepayment = emi * n
    return {
        emi: round2(emi),
        totalRepayment: round2(totalRepayment),
        totalInterest: round2(totalRepayment - p)
    }
}
function round2(v) { return Math.round(v * 100) / 100 }

async function listProducts(_req, res) {
    const db = await getDb()
    const rows = await db.select().from(schema.loanProducts).orderBy(schema.loanProducts.name)
    res.status(200).json({
        products: rows.map((p) => ({
            ...p,
            interestRate: Number(p.interestRate),
            minAmount: Number(p.minAmount),
            maxAmount: Number(p.maxAmount)
        }))
    })
}

async function calculate(req, res) {
    const { productCode, principal, tenureMonths } = req.body || {}
    if (!productCode || !principal || !tenureMonths) {
        return res.status(400).json({ message: "productCode, principal and tenureMonths are required" })
    }
    const db = await getDb()
    const products = await db.select().from(schema.loanProducts).where(eq(schema.loanProducts.code, productCode)).limit(1)
    if (products.length === 0) return res.status(404).json({ message: "Product not found" })
    const p = products[0]
    const P = Number(principal)
    if (P < Number(p.minAmount) || P > Number(p.maxAmount)) {
        return res.status(400).json({ message: `Amount must be between ${p.minAmount} and ${p.maxAmount}` })
    }
    if (tenureMonths < p.minTenure || tenureMonths > p.maxTenure) {
        return res.status(400).json({ message: `Tenure must be between ${p.minTenure} and ${p.maxTenure} months` })
    }

    await rewards.awardByCondition(req.user.id, "loan.emi.calculated")

    const calc = computeEmi(P, Number(p.interestRate), tenureMonths)
    res.status(200).json({
        product: { ...p, interestRate: Number(p.interestRate) },
        principal: P,
        tenureMonths,
        interestRate: Number(p.interestRate),
        ...calc
    })
}

async function apply(req, res) {
    const { productCode, principal, tenureMonths } = req.body || {}
    const db = await getDb()
    const products = await db.select().from(schema.loanProducts).where(eq(schema.loanProducts.code, productCode)).limit(1)
    if (products.length === 0) return res.status(404).json({ message: "Product not found" })
    const p = products[0]

    const P = Number(principal)
    if (!P || P < Number(p.minAmount) || P > Number(p.maxAmount)) {
        return res.status(400).json({ message: `Amount must be between ${p.minAmount} and ${p.maxAmount}` })
    }
    if (!tenureMonths || tenureMonths < p.minTenure || tenureMonths > p.maxTenure) {
        return res.status(400).json({ message: `Tenure must be between ${p.minTenure} and ${p.maxTenure} months` })
    }

    const calc = computeEmi(P, Number(p.interestRate), tenureMonths)

    const [app] = await db
        .insert(schema.loanApplications)
        .values({
            userId: req.user.id,
            productId: p.id,
            principal: P.toFixed(2),
            tenureMonths,
            interestRate: Number(p.interestRate).toFixed(3),
            emi: calc.emi.toFixed(2),
            totalInterest: calc.totalInterest.toFixed(2),
            totalRepayment: calc.totalRepayment.toFixed(2),
            status: "APPROVED"
        })
        .returning()

    await rewards.awardByCondition(req.user.id, "loan.applied.first")
    await rewards.awardByCondition(req.user.id, `loan.applied.${p.code}`)
    t()?.metrics?.loansApplied?.add(1, { product: p.code })

    res.status(201).json({ application: shape(app) })
}

async function listApplications(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.loanApplications)
        .where(eq(schema.loanApplications.userId, req.user.id))
        .orderBy(desc(schema.loanApplications.createdAt))
    // Join with product for display
    const products = await db.select().from(schema.loanProducts)
    const byId = new Map(products.map((p) => [p.id, p]))
    res.status(200).json({
        applications: rows.map((r) => ({
            ...shape(r),
            product: byId.get(r.productId) ? {
                id: byId.get(r.productId).id,
                code: byId.get(r.productId).code,
                name: byId.get(r.productId).name
            } : null
        }))
    })
}

function shape(r) {
    return {
        ...r,
        principal: Number(r.principal),
        interestRate: Number(r.interestRate),
        emi: Number(r.emi),
        totalInterest: Number(r.totalInterest),
        totalRepayment: Number(r.totalRepayment)
    }
}

/**
 * GET /api/loans/applications/:id
 * Loan-detail view: application + product + a small computed repayment schedule.
 */
async function getApplicationDetail(req, res) {
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.loanApplications)
        .where(and(
            eq(schema.loanApplications.id, req.params.id),
            eq(schema.loanApplications.userId, req.user.id)
        ))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Loan application not found" })
    const app = rows[0]

    const productRows = await db
        .select()
        .from(schema.loanProducts)
        .where(eq(schema.loanProducts.id, app.productId))
        .limit(1)
    const product = productRows[0]

    // Small illustrative repayment schedule (first 6 EMIs)
    const P = Number(app.principal)
    const r = Number(app.interestRate) / 100 / 12
    const emi = Number(app.emi)
    let balance = P
    const schedule = []
    for (let i = 1; i <= Math.min(6, app.tenureMonths); i++) {
        const interest = balance * r
        const principalPart = emi - interest
        balance = Math.max(0, balance - principalPart)
        schedule.push({
            n: i,
            emi: round2(emi),
            interest: round2(interest),
            principal: round2(principalPart),
            outstanding: round2(balance)
        })
    }

    res.status(200).json({ application: shape(app), product, schedule })
}
function round2(v) { return Math.round(v * 100) / 100 }

/**
 * POST /api/loans/applications/:id/close
 * Closes an eligible loan application.
 * Uses status transitions rather than deletion:
 *   - PENDING -> REJECTED (user cancelled)
 *   - APPROVED/DISBURSED -> CLOSED
 * Retains the full historical record.
 */
async function closeApplication(req, res) {
    const { reason } = req.body || {}
    const db = await getDb()
    const rows = await db
        .select()
        .from(schema.loanApplications)
        .where(and(
            eq(schema.loanApplications.id, req.params.id),
            eq(schema.loanApplications.userId, req.user.id)
        ))
        .limit(1)
    if (rows.length === 0) return res.status(404).json({ message: "Loan application not found" })
    const app = rows[0]

    if (app.status === "CLOSED" || app.status === "REJECTED") {
        return res.status(400).json({ message: `Loan is already ${app.status}` })
    }

    const nextStatus = app.status === "PENDING" ? "REJECTED" : "CLOSED"
    const [updated] = await db
        .update(schema.loanApplications)
        .set({
            status: nextStatus,
            closedAt: new Date(),
            closeReason: (reason && String(reason).trim()) || (nextStatus === "REJECTED" ? "Cancelled by user" : "Closed by user"),
            updatedAt: new Date()
        })
        .where(eq(schema.loanApplications.id, app.id))
        .returning()

    t()?.metrics?.loansClosed?.add(1, { status: nextStatus })
    res.status(200).json({ application: shape(updated) })
}

function _dedupedShape(r) {
    return {
        ...r,
        principal: Number(r.principal),
        interestRate: Number(r.interestRate),
        emi: Number(r.emi),
        totalInterest: Number(r.totalInterest),
        totalRepayment: Number(r.totalRepayment)
    }
}

module.exports = { listProducts, calculate, apply, listApplications, computeEmi, getApplicationDetail, closeApplication }
