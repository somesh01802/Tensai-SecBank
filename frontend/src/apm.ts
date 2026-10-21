import { init as initApm } from "@elastic/apm-rum"

/**
 * Elastic RUM (Real User Monitoring). Auto-instruments page-load, route-change,
 * click, and XHR/fetch transactions in the browser and ships them to the Elastic
 * APM server. Config is read from Vite env (VITE_ELASTIC_RUM_*), with the
 * project defaults as fallback so it works out of the box.
 *
 * Note: the RUM serverUrl + serviceName are shipped to the browser by design —
 * they are not secrets. The APM secret token is used only by the PHP agent
 * (server side) and is never exposed here.
 */
const env = import.meta.env as Record<string, string | undefined>

// Origins that get the W3C traceparent/tracestate headers so the browser
// transaction links to the PHP backend transaction (distributed tracing).
// Always includes the SSH-tunnel origin, the page's own origin and the API
// origin (if VITE_API_BASE_URL is absolute), plus anything in VITE_ELASTIC_RUM_ORIGINS.
function tracingOrigins(): string[] {
  const list = ["http://localhost:8088", window.location.origin]
  try {
    const api = env.VITE_API_BASE_URL
    if (api && /^https?:\/\//.test(api)) list.push(new URL(api).origin)
  } catch {
    /* relative base URL — same origin, already covered */
  }
  for (const o of (env.VITE_ELASTIC_RUM_ORIGINS || "").split(",")) if (o.trim()) list.push(o.trim())
  return [...new Set(list)]
}

export const apm = initApm({
  serviceName: env.VITE_ELASTIC_RUM_SERVICE_NAME || "tensai-secbank-web",
  serverUrl:
    env.VITE_ELASTIC_RUM_SERVER_URL ||
    "https://6131e45d909f42e4805c71ae8639c495.apm.us-east-1.aws.cloud.es.io:443",
  serviceVersion: env.VITE_ELASTIC_RUM_SERVICE_VERSION || "0.1.0",
  environment: env.VITE_ELASTIC_RUM_ENVIRONMENT || env.MODE || "production",
  // Distributed tracing: correlate the browser transaction with the PHP backend.
  distributedTracingOrigins: tracingOrigins(),
  propagateTracestate: true,
})
