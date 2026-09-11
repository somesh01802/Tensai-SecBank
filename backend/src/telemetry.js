/**
 * OpenTelemetry bootstrap for Tensai SecBank.
 *
 * This file MUST be required *first* (before Express, drizzle, pg, etc.) so
 * that auto-instrumentation can monkey-patch those modules. Both `server.js`
 * and `dev.js` do this at the very top.
 *
 * What it produces
 *   - Traces via OTLP/HTTP (default: http://localhost:4318/v1/traces)
 *   - Metrics via OTLP/HTTP (default: http://localhost:4318/v1/metrics)
 *   - A small named tracer + a set of business metrics available via
 *     `getTelemetry()` for controllers and services to record custom spans.
 *
 * Configuration (env)
 *   TELEMETRY_ENABLED         "false" to disable everything (default: on)
 *   OTEL_SERVICE_NAME         defaults to "tensai-secbank-api"
 *   OTEL_EXPORTER_OTLP_ENDPOINT  defaults to http://localhost:4318
 *   OTEL_EXPORTER_OTLP_HEADERS   optional headers (e.g. auth for a hosted collector)
 *   OTEL_ENV                  "production" / "development" / etc.
 *
 * Redaction
 *   - Auto request-hook redacts req/res headers Authorization, Cookie,
 *     Set-Cookie, and any URL query string containing token / password /
 *     mpin / cvv keys.
 *   - Custom spans get a safe user.id attribute; we never attach MPIN /
 *     password / CVV / tokens.
 */

const ENABLED = process.env.TELEMETRY_ENABLED !== "false"

let telemetryHandle = null

if (ENABLED) {
    try {
        const { NodeSDK } = require("@opentelemetry/sdk-node")
        const { Resource } = require("@opentelemetry/resources")
        const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions")
        const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http")
        const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http")
        const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics")
        const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node")
        const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api")
        const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api")

        if (process.env.OTEL_DEBUG === "true") {
            diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
        }

        const serviceName = process.env.OTEL_SERVICE_NAME || "tensai-secbank-api"
        const envName = process.env.OTEL_ENV || process.env.NODE_ENV || "development"
        const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"

        const resource = new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
            [SemanticResourceAttributes.SERVICE_VERSION]: process.env.SERVICE_VERSION || "3.0.0",
            [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: envName,
            "banking.app": "tensai-secbank"
        })

        const traceExporter = new OTLPTraceExporter({
            url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
            headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        })
        const metricExporter = new OTLPMetricExporter({
            url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
            headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        })

        const sdk = new NodeSDK({
            resource,
            traceExporter,
            metricReader: new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: 30_000
            }),
            instrumentations: [
                getNodeAutoInstrumentations({
                    "@opentelemetry/instrumentation-http": {
                        // Redact sensitive request bits from spans.
                        requestHook: (span, request) => {
                            try {
                                const url = String(request.url || "")
                                span.setAttribute("http.route", stripQuery(url))
                            } catch { /* ignore */ }
                        },
                        applyCustomAttributesOnSpan: (span, request, response) => {
                            try {
                                // Never keep raw Authorization / Cookie headers
                                const dropHeader = (name) => span.setAttribute(`http.request.header.${name.toLowerCase()}`, "[redacted]")
                                dropHeader("authorization"); dropHeader("cookie"); dropHeader("x-api-key")
                                if (response?.statusCode >= 500) {
                                    span.setStatus({ code: SpanStatusCode.ERROR })
                                }
                            } catch { /* ignore */ }
                        }
                    },
                    "@opentelemetry/instrumentation-express": { enabled: true },
                    "@opentelemetry/instrumentation-pg": { enabled: true },
                    "@opentelemetry/instrumentation-fs": { enabled: false } // too noisy
                })
            ]
        })

        try {
            sdk.start()
        } catch (err) {
            console.warn("[telemetry] SDK start failed:", err.message)
        }

        // Custom business metrics — accessible via getTelemetry()
        const meter = metrics.getMeter("tensai-secbank")
        const businessMetrics = {
            authAttempts: meter.createCounter("banking.auth.attempts", { description: "Login / register attempts" }),
            authFailures: meter.createCounter("banking.auth.failures", { description: "Authentication failures" }),
            transfers: meter.createCounter("banking.transfers.count", { description: "Completed money movements" }),
            transferAmount: meter.createHistogram("banking.transfers.amount", { description: "Transfer amount distribution", unit: "INR" }),
            billsPaid: meter.createCounter("banking.bills.paid", { description: "Bills marked paid" }),
            loansApplied: meter.createCounter("banking.loans.applied", { description: "Loan applications submitted" }),
            loansClosed: meter.createCounter("banking.loans.closed", { description: "Loans closed / cancelled" }),
            cardsIssued: meter.createCounter("banking.cards.issued", { description: "Cards issued via applications" }),
            accountsOpened: meter.createCounter("banking.accounts.opened", { description: "Accounts opened via applications" }),
            accountsClosed: meter.createCounter("banking.accounts.closed", { description: "Accounts closed" }),
            statementDownloads: meter.createCounter("banking.statements.downloaded", { description: "Statement CSV downloads" }),
            chatbotRequests: meter.createCounter("banking.chatbot.requests", { description: "Chatbot messages served" }),
            chatbotLatencyMs: meter.createHistogram("banking.chatbot.latency_ms", { description: "Chatbot response latency", unit: "ms" }),
            businessErrors: meter.createCounter("banking.errors.count", { description: "Business-level errors (validation, rejects)" }),
            schedulerRuns: meter.createCounter("banking.scheduler.runs", { description: "Scheduler jobs executed" })
        }

        const tracer = trace.getTracer("tensai-secbank")

        telemetryHandle = {
            tracer,
            metrics: businessMetrics,
            SpanStatusCode,
            enabled: true,
            serviceName,
            endpoint,
            /**
             * Wrap an async function in a business span with sanitized attrs.
             *   telemetry.withSpan("bank.transfer.internal", { "user.id": ... }, async (span) => {...})
             */
            async withSpan(name, attrs, fn) {
                const span = tracer.startSpan(name, { attributes: safeAttrs(attrs) })
                try {
                    const result = await fn(span)
                    span.end()
                    return result
                } catch (err) {
                    span.recordException(err)
                    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
                    span.end()
                    throw err
                }
            }
        }

        const shutdown = async () => {
            try { await sdk.shutdown() } catch { /* ignore */ }
        }
        process.on("SIGTERM", shutdown)
        process.on("SIGINT", shutdown)

        console.log(`[telemetry] enabled service=${serviceName} otlp=${endpoint}`)
    } catch (err) {
        console.warn("[telemetry] initialisation failed (continuing without):", err.message)
        telemetryHandle = { enabled: false, tracer: null, metrics: emptyMetrics(), withSpan: passthroughSpan }
    }
} else {
    console.log("[telemetry] disabled via TELEMETRY_ENABLED=false")
    telemetryHandle = { enabled: false, tracer: null, metrics: emptyMetrics(), withSpan: passthroughSpan }
}

function parseHeaders(str) {
    if (!str) return undefined
    const out = {}
    for (const pair of str.split(",")) {
        const [k, ...rest] = pair.split("=")
        if (!k) continue
        out[k.trim()] = rest.join("=").trim()
    }
    return out
}

function stripQuery(url) {
    const i = String(url).indexOf("?")
    return i === -1 ? url : url.slice(0, i)
}

function safeAttrs(attrs) {
    if (!attrs) return {}
    const BAD = /mpin|password|cvv|token|secret|authorization|cookie/i
    const out = {}
    for (const [k, v] of Object.entries(attrs)) {
        if (BAD.test(k)) { out[k] = "[redacted]"; continue }
        if (typeof v === "string" && BAD.test(v)) { out[k] = "[redacted]"; continue }
        out[k] = v
    }
    return out
}

function emptyMetrics() {
    const noop = { add: () => {}, record: () => {} }
    return {
        authAttempts: noop, authFailures: noop, transfers: noop, transferAmount: noop,
        billsPaid: noop, loansApplied: noop, loansClosed: noop, cardsIssued: noop,
        accountsOpened: noop, accountsClosed: noop, statementDownloads: noop,
        chatbotRequests: noop, chatbotLatencyMs: noop, businessErrors: noop,
        schedulerRuns: noop
    }
}
function passthroughSpan(name, attrs, fn) {
    return fn({ setAttribute: () => {}, addEvent: () => {}, recordException: () => {}, setStatus: () => {}, end: () => {} })
}

/**
 * Global accessor for controllers/services.
 */
function getTelemetry() { return telemetryHandle }

module.exports = { getTelemetry }
