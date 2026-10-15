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

export const apm = initApm({
  serviceName: env.VITE_ELASTIC_RUM_SERVICE_NAME || "tensai-secbank-web",
  serverUrl:
    env.VITE_ELASTIC_RUM_SERVER_URL ||
    "https://6131e45d909f42e4805c71ae8639c495.apm.us-east-1.aws.cloud.es.io:443",
  serviceVersion: env.VITE_ELASTIC_RUM_SERVICE_VERSION || "0.1.0",
  environment: env.VITE_ELASTIC_RUM_ENVIRONMENT || env.MODE || "production",
  // Distributed tracing: correlate the browser transaction with the PHP backend.
  distributedTracingOrigins: (env.VITE_ELASTIC_RUM_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
})
