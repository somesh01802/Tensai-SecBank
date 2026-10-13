const crypto = require("crypto")
const https = require("https")
const path = require("path")
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true })

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const authorization = parseAuthorization(process.env.OTEL_EXPORTER_OTLP_HEADERS)

if (!endpoint || !authorization) {
    console.error("Configure OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS in backend/.env")
    process.exit(1)
}

const baseUrl = new URL(endpoint)
const now = (BigInt(Date.now()) * 1_000_000n).toString()
const resource = {
    attributes: resourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES)
}
resource.attributes.push({
    key: "service.name",
    value: { stringValue: process.env.OTEL_SERVICE_NAME || "tensai-secbank-api" }
})

const scope = { name: "tensai-secbank-apm-verification" }
const signals = {
    traces: {
        resourceSpans: [{
            resource,
            scopeSpans: [{
                scope,
                spans: [{
                    traceId: crypto.randomBytes(16).toString("hex"),
                    spanId: crypto.randomBytes(8).toString("hex"),
                    name: "tensai.secbank.apm.validation",
                    kind: 1,
                    startTimeUnixNano: now,
                    endTimeUnixNano: (BigInt(now) + 1_000_000n).toString(),
                    status: { code: 1 }
                }]
            }]
        }]
    },
    metrics: {
        resourceMetrics: [{
            resource,
            scopeMetrics: [{
                scope,
                metrics: [{
                    name: "tensai.secbank.apm.validation",
                    unit: "1",
                    gauge: { dataPoints: [{ timeUnixNano: now, asDouble: 1 }] }
                }]
            }]
        }]
    },
    logs: {
        resourceLogs: [{
            resource,
            scopeLogs: [{
                scope,
                logRecords: [{
                    timeUnixNano: now,
                    observedTimeUnixNano: now,
                    severityNumber: 9,
                    severityText: "INFO",
                    body: { stringValue: "Elastic OTLP pipeline validation" }
                }]
            }]
        }]
    }
}

async function main() {
    let failed = false
    for (const [signal, payload] of Object.entries(signals)) {
        try {
            const status = await send(signal, payload)
            console.log(`${signal}: HTTP ${status}`)
            if (status < 200 || status >= 300) failed = true
        } catch (error) {
            console.log(`${signal}: request failed (${error.code || "network error"})`)
            failed = true
        }
    }
    if (failed) process.exitCode = 1
}

function send(signal, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload)
        const request = https.request({
            hostname: baseUrl.hostname,
            port: baseUrl.port || 443,
            path: `/v1/${signal}`,
            method: "POST",
            headers: {
                Authorization: authorization,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body)
            }
        }, (response) => {
            response.resume()
            response.on("end", () => resolve(response.statusCode || 0))
        })
        request.on("error", reject)
        request.end(body)
    })
}

function parseAuthorization(value = "") {
    const separator = value.indexOf("=")
    if (separator < 1) return ""
    const key = value.slice(0, separator).trim().toLowerCase()
    return key === "authorization" ? value.slice(separator + 1).trim() : ""
}

function resourceAttributes(value = "") {
    return value.split(",").flatMap((entry) => {
        const separator = entry.indexOf("=")
        if (separator < 1) return []
        return [{
            key: entry.slice(0, separator).trim(),
            value: { stringValue: entry.slice(separator + 1).trim() }
        }]
    })
}

main()