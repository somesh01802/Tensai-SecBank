/**
 * OpenTelemetry bootstrap for Tensai SecBank.
 *
 * This file MUST be required *first* (before Express, drizzle, pg, etc.) so
 * that auto-instrumentation can monkey-patch those modules. Both `server.js`
 * and `dev.js` do this at the very top.
 *
 * What it produces
 *   - Traces, metrics, and application logs via OTLP/HTTP
 *   - A small named tracer + a set of business metrics available via
 *     `getTelemetry()` for controllers and services to record custom spans.
 *
 * Configuration (env)
 *   TELEMETRY_ENABLED         "false" to disable everything (default: on)
 *   OTEL_SERVICE_NAME         defaults to "tensai-secbank-api"
 *   OTEL_EXPORTER_OTLP_ENDPOINT  defaults to http://localhost:4318
 *   OTEL_EXPORTER_OTLP_HEADERS   optional headers (e.g. auth for a hosted collector)
 *   OTEL_RESOURCE_ATTRIBUTES    additional comma-separated resource attributes
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
        const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http")
        const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics")
        const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs")
        const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node")
        const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api")
        const { logs, SeverityNumber } = require("@opentelemetry/api-logs")
        const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api")

        if (process.env.OTEL_DEBUG === "true") {
            diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
        }

        const serviceName = process.env.OTEL_SERVICE_NAME || "tensai-secbank-api"
        const envName = process.env.OTEL_ENV || process.env.NODE_ENV || "development"
        const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"
        const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        const baseEndpoint = endpoint.replace(/\/$/, "")

        const resource = new Resource({
            ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
            [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
            [SemanticResourceAttributes.SERVICE_VERSION]: process.env.SERVICE_VERSION || "3.0.0",
            [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: envName,
            "deployment.environment.name": envName,
            "service.namespace": "tensai",
            "banking.app": "tensai-secbank",
            "banking.component": "backend"
        })

        const traceExporter = new OTLPTraceExporter({
            url: `${baseEndpoint}/v1/traces`,
            headers
        })
        const metricExporter = new OTLPMetricExporter({
            url: `${baseEndpoint}/v1/metrics`,
            headers
        })
        const logExporter = new OTLPLogExporter({
            url: `${baseEndpoint}/v1/logs`,
            headers
        })

        const sdk = new NodeSDK({
            resource,
            traceExporter,
            logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
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
            installConsoleLogBridge(logs.getLogger("tensai-secbank"), SeverityNumber)
        } catch (err) {
            console.warn("[telemetry] SDK start failed:", err.message)
        }

        // Custom business metrics — accessible via getTelemetry()
        const meter = metrics.getMeter("tensai-secbank")
        const businessMetrics = {
            authAttempts: meter.createCounter("banking.auth.attempts", { description: "Login / register attempts" }),
            authFailures: meter.createCounter("banking.auth.failures", { description: "Authentication failures" }),
            transfers: meter.createCounter("banking.transfers.count", { description: "Completed money movements" }),
            transferAmount: meter.createHistogram("banking.transfers.amount", { description: "Transfer amount distribution", unit: "USD" }),
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
        const txLogger = (() => { try { return logs.getLogger("tensai-secbank.tx") } catch { return null } })()

        telemetryHandle = {
            tracer,
            metrics: businessMetrics,
            SpanStatusCode,
            enabled: true,
            serviceName,
            endpoint,
            environment: envName,
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
            },
            /**
             * Emit a fully-attributed transaction span + metrics + a structured
             * log — the single place transaction context is recorded, reused by
             * the live controller AND the synthetic seed. `info` carries only
             * privacy-safe fields; never pass card numbers / CVV / tokens.
             */
            recordTransaction(info = {}) {
                const {
                    transactionId, userId, operation = "transfer",
                    fromLast4, toLast4, amount, currency = "USD",
                    outcome = "SUCCESS", status, errorCategory, failureReason,
                    endpoint: ep, durationMs, synthetic = false,
                    startTimeMs
                } = info
                const span = tracer.startSpan("bank.transaction", {
                    startTime: startTimeMs ? new Date(startTimeMs) : undefined,
                    attributes: safeAttrs({
                        "banking.transaction.id": transactionId,
                        "banking.user.id": userId,                 // synthetic/opaque UUID
                        "banking.operation": operation,
                        "banking.account.from_last4": fromLast4,
                        "banking.account.to_last4": toLast4,
                        "banking.amount": amount != null ? Number(amount) : undefined,
                        "banking.currency": currency,
                        "banking.outcome": outcome,                // SUCCESS | FAILURE
                        "banking.transaction.status": status,      // COMPLETED | FAILED | ...
                        "banking.error.category": errorCategory,   // normalized, e.g. DB_DEADLOCK
                        "banking.failure.reason": failureReason,
                        "banking.synthetic": synthetic,
                        "http.route": ep,
                        "service.name": serviceName,
                        "deployment.environment": envName,
                        "duration.ms": durationMs != null ? Number(durationMs) : undefined
                    })
                })
                if (outcome === "FAILURE") {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: failureReason || errorCategory || "transaction failed" })
                    businessMetrics.businessErrors.add(1, { operation, category: errorCategory || "unknown" })
                } else {
                    businessMetrics.transfers.add(1, { operation, status: status || "COMPLETED" })
                    if (amount != null) businessMetrics.transferAmount.record(Number(amount), { operation })
                }
                const sc = span.spanContext()
                if (txLogger) {
                    try {
                        txLogger.emit({
                            severityNumber: outcome === "FAILURE" ? SeverityNumber.ERROR : SeverityNumber.INFO,
                            severityText: outcome === "FAILURE" ? "ERROR" : "INFO",
                            body: `transaction ${outcome} ${operation} ${currency} ${amount ?? ""} ${errorCategory || ""}`.trim(),
                            attributes: safeAttrs({
                                "banking.transaction.id": transactionId,
                                "banking.user.id": userId,
                                "banking.outcome": outcome,
                                "banking.error.category": errorCategory,
                                "trace_id": sc.traceId,
                                "span_id": sc.spanId
                            })
                        })
                    } catch { /* logging must not break the money path */ }
                }
                if (durationMs != null) {
                    span.end(startTimeMs ? new Date(startTimeMs + Number(durationMs)) : undefined)
                } else {
                    span.end()
                }
                return { traceId: sc.traceId, spanId: sc.spanId }
            }
        }

        const shutdown = async () => {
            try { await sdk.shutdown() } catch { /* ignore */ }
        }
        telemetryHandle.shutdown = shutdown   // let batch scripts flush before exit
        process.on("SIGTERM", shutdown)
        process.on("SIGINT", shutdown)

        console.log(`[telemetry] enabled service=${serviceName} otlp=${endpoint}`)
    } catch (err) {
        console.warn("[telemetry] initialisation failed (continuing without):", err.message)
        telemetryHandle = { enabled: false, tracer: null, metrics: emptyMetrics(), withSpan: passthroughSpan, recordTransaction: noopRecordTransaction, shutdown: async () => {}, environment: process.env.OTEL_ENV || process.env.NODE_ENV || "development" }
    }
} else {
    console.log("[telemetry] disabled via TELEMETRY_ENABLED=false")
    telemetryHandle = { enabled: false, tracer: null, metrics: emptyMetrics(), withSpan: passthroughSpan, recordTransaction: noopRecordTransaction, shutdown: async () => {}, environment: process.env.OTEL_ENV || process.env.NODE_ENV || "development" }
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

function parseResourceAttributes(str) {
    if (!str) return {}
    return Object.fromEntries(str.split(",").flatMap((entry) => {
        const separator = entry.indexOf("=")
        if (separator < 1) return []
        return [[entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]]
    }))
}

function installConsoleLogBridge(logger, severity) {
    if (console.__otelLogBridgeInstalled) return
    Object.defineProperty(console, "__otelLogBridgeInstalled", { value: true })

    const methods = [
        ["debug", severity.DEBUG],
        ["info", severity.INFO],
        ["log", severity.INFO],
        ["warn", severity.WARN],
        ["error", severity.ERROR]
    ]

    for (const [method, severityNumber] of methods) {
        const original = console[method].bind(console)
        console[method] = (...args) => {
            original(...args)
            try {
                logger.emit({
                    severityNumber,
                    severityText: method.toUpperCase(),
                    body: args.map((value) => formatLogValue(value)).join(" "),
                    attributes: { "log.source": "console" }
                })
            } catch { /* logging must not disrupt application behavior */ }
        }
    }
}

function formatLogValue(value) {
    if (value instanceof Error) return redactText(`${value.name}: ${value.message}`)
    if (typeof value === "string") return redactText(value)
    try {
        return redactText(JSON.stringify(redactLogValue(value)))
    } catch {
        return redactText(String(value))
    }
}

function redactLogValue(value, key = "") {
    if (/(password|mpin|cvv|token|secret|authorization|cookie|api.?key|pan|mobile|phone|email|name|dob|birth|address|account.?number|card.?number|full.?number)/i.test(key)) {
        return "[REDACTED]"
    }
    if (Array.isArray(value)) return value.map((item) => redactLogValue(item))
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            redactLogValue(childValue, childKey)
        ]))
    }
    return typeof value === "string" ? redactText(value) : value
}

function redactText(value) {
    return String(value)
        .replace(/((?:password|mpin|cvv|token|secret|authorization|cookie|api.?key|pan|mobile|phone|email|name|dob|birth|address|account.?number|card.?number|full.?number)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
        .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
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
function noopRecordTransaction() { return { traceId: null, spanId: null } }

/**
 * Global accessor for controllers/services.
 */
function getTelemetry() { return telemetryHandle }

module.exports = { getTelemetry }
