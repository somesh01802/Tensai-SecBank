const { trace } = (() => { try { return require("@opentelemetry/api") } catch { return {} } })()
const { randomUUID } = require("crypto")

/**
 * Adds a correlation id (x-request-id) + a compact set of banking attributes
 * to the active span for every request. Runs BEFORE routes so it always sees
 * the HTTP root span created by auto-instrumentation.
 */
function telemetryContext(req, res, next) {
    const requestId = req.headers["x-request-id"] || randomUUID()
    req.requestId = requestId
    res.setHeader("x-request-id", requestId)

    try {
        const span = trace?.getActiveSpan?.()
        if (span) {
            span.setAttribute("banking.request_id", requestId)
            span.setAttribute("banking.endpoint", req.method + " " + req.path)
            // req.user is populated by authMiddleware AFTER this middleware, so
            // attach it below (via res.on("finish")) once we know who the caller
            // was and whether they authenticated.
            res.on("finish", () => {
                try {
                    if (req.user?.id) span.setAttribute("banking.user.id", req.user.id)
                    span.setAttribute("banking.response.status", res.statusCode)
                } catch { /* ignore */ }
            })
        }
    } catch { /* ignore */ }

    next()
}

module.exports = { telemetryContext }
