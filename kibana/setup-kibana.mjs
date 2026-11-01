// Creates the Kibana-side objects the SecBank dashboards refer to: journey SLOs with burn-rate rules, alert rules
// (open business problems, payments-svc errors and latency) and ML anomaly detection jobs. Idempotent: every object
// has a fixed "secbank" id and is created or updated in place; nothing else is touched.
//
//   node kibana/setup-kibana.mjs                 create or update everything
//   node kibana/setup-kibana.mjs --forecast      also run a 1-day ML forecast on pod memory (after the job has a few hours of data)
//   node kibana/setup-kibana.mjs --remove        delete only these secbank objects (SLOs, rules, ML jobs)
//
// Config from api/.env (or the environment): KIBANA_URL, KIBANA_API_KEY (an Elasticsearch API key of a user with
// Kibana SLO / alerting / ML privileges), ES_URL. The key is used for both Kibana and Elasticsearch (ML jobs).
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const envFile = fileURLToPath(new URL("../api/.env", import.meta.url))
const fileEnv = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, "utf8").split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^["']|["']$/g, "")])) : {}
const env = (k) => process.env[k] || fileEnv[k] || ""
const KIBANA = env("KIBANA_URL").replace(/\/$/, ""), ES = env("ES_URL").replace(/\/$/, ""), KEY = env("KIBANA_API_KEY")
if (!KIBANA || !ES) { console.error("KIBANA_URL and ES_URL must be set (api/.env)"); process.exit(1) }
const args = process.argv.slice(2)

async function call(base, method, path, body) {
  const headers = { "Content-Type": "application/json", "kbn-xsrf": "secbank", "elastic-api-version": "2023-10-31" }
  if (KEY) headers.Authorization = `ApiKey ${KEY}`
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}
const kb = (m, p, b) => call(KIBANA, m, p, b)
const es = (m, p, b) => call(ES, m, p, b)
let failed = 0
const report = (what, r, okStatuses = [200, 201, 204]) => {
  const ok = okStatuses.includes(r.status)
  if (!ok) failed++
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`}`)
  return ok
}

// ---------- journey SLOs (custom KQL on business events; same targets as the bank_journeys table) ----------
const JOURNEYS = { login: ["Login", 0.995], onboarding: ["Onboarding", 0.92], view_accounts: ["View accounts", 0.995], bill_pay: ["Bill pay", 0.99],
  autopay_setup: ["Autopay setup", 0.95], p2p_transfer: ["P2P transfer", 0.97], card_payment: ["Card payment", 0.99],
  card_controls: ["Card controls", 0.99], loan_apply: ["Loan apply", 0.85], dispute: ["Dispute", 0.97] }
const slo = (j, [label, target]) => ({
  name: `SecBank journey completion: ${label}`, description: `Completed over attempts for ${label} (business events). Load tests excluded.`,
  indicator: { type: "sli.kql.custom", params: { index: "logs-bank.business-*", timestampField: "@timestamp",
    good: 'journey.status : "completed"', total: 'journey.status : ("completed" or "failed" or "abandoned" or "pending")',
    filter: `journey.name : "${j}" and not (labels.data_source : "app" and labels.synthetic_user : true)` } },
  timeWindow: { duration: "30d", type: "rolling" }, budgetingMethod: "occurrences", objective: { target },
  tags: ["secbank", "journey"], settings: { syncDelay: "1m", frequency: "1m", preventInitialBackfill: false },
})
const sloId = (j) => `secbank-${j.replace(/_/g, "-")}`

// ---------- rules ----------
const RULE_BASE = { tags: ["secbank"], schedule: { interval: "1m" }, actions: [], notify_when: "onActionGroupChange" }
const burnRule = (j, label) => ({ ...RULE_BASE, name: `SecBank SLO burn rate: ${label}`, rule_type_id: "slo.rules.burnRate", consumer: "slo",
  params: { sloId: sloId(j), windows: [
    { id: "fast", burnRateThreshold: 14.4, maxBurnRateThreshold: 720, longWindow: { value: 1, unit: "h" }, shortWindow: { value: 5, unit: "m" }, actionGroup: "slo.burnRate.alert" },
    { id: "slow", burnRateThreshold: 6, maxBurnRateThreshold: 120, longWindow: { value: 6, unit: "h" }, shortWindow: { value: 30, unit: "m" }, actionGroup: "slo.burnRate.high" }] } })
const RULES = {
  "secbank-rule-problems": { ...RULE_BASE, name: "SecBank: open business problem (critical or major)", rule_type_id: ".es-query", consumer: "stackAlerts",
    params: { searchType: "esqlQuery", timeField: "problem.last_seen_at", timeWindowSize: 5, timeWindowUnit: "m", threshold: [0], thresholdComparator: ">",
      size: 0, esqlQuery: { esql: 'FROM bank-problems | WHERE problem.status == "open" AND problem.severity IN ("critical", "major") | KEEP problem.id, problem.severity, problem.title, problem.owner | LIMIT 100' } } },
  "secbank-rule-payments-errors": { ...RULE_BASE, name: "SecBank: payments-svc error rate above 5 %", rule_type_id: "apm.transaction_error_rate", consumer: "apm",
    params: { serviceName: "payments-svc", transactionType: "request", environment: "production", threshold: 5, windowSize: 5, windowUnit: "m" } },
  "secbank-rule-payments-latency": { ...RULE_BASE, name: "SecBank: payments-svc p95 latency above 3 s", rule_type_id: "apm.transaction_duration", consumer: "apm",
    params: { serviceName: "payments-svc", transactionType: "request", environment: "production", threshold: 3000, windowSize: 5, windowUnit: "m", aggregationType: "95th" } },
}

// ---------- ML anomaly detection (datafeeds start from 7 days back, then run in real time) ----------
const ML = {
  "secbank-autopay-volume": { desc: "Autopay run volume (S9: silent skip)", index: "logs-bank.business-*", query: { term: { "event.category": "autopay_run" } },
    analysis: { bucket_span: "5m", detectors: [{ function: "low_count", detector_description: "autopay runs per 5 min" }] } },
  "secbank-payment-gw-latency": { desc: "payment_gw latency (S1)", index: "traces-apm*", query: { term: { "span.destination.service.resource": "payment_gw" } },
    analysis: { bucket_span: "5m", detectors: [{ function: "high_mean", field_name: "span.duration.us", detector_description: "payment_gw mean latency" }] } },
  "secbank-branch-volume": { desc: "Teller and ATM volume per branch (S10)", index: "logs-bank.business-*", query: { terms: { "bank.channel": ["branch", "atm"] } },
    analysis: { bucket_span: "15m", detectors: [{ function: "low_count", partition_field_name: "bank.branch.id", detector_description: "branch activity" }],
      influencers: ["bank.branch.id", "bank.region"] } },
  "secbank-pod-memory": { desc: "Pod memory by service, with forecast (S8)", index: "metrics-bank.platform-*", query: { term: { "metricset.name": "pod" } },
    analysis: { bucket_span: "15m", detectors: [{ function: "max", field_name: "kubernetes.pod.memory.pct", partition_field_name: "service.name", detector_description: "pod memory" }],
      influencers: ["service.name"] } },
}

if (args.includes("--remove")) {
  for (const id of Object.keys(ML)) {
    await es("POST", `/_ml/datafeeds/datafeed-${id}/_stop?force=true`)
    report(`remove datafeed ${id}`, await es("DELETE", `/_ml/datafeeds/datafeed-${id}`), [200, 404])
    await es("POST", `/_ml/anomaly_detectors/${id}/_close?force=true`)
    report(`remove ML job ${id}`, await es("DELETE", `/_ml/anomaly_detectors/${id}`), [200, 404])
  }
  for (const id of [...Object.keys(RULES), ...Object.keys(JOURNEYS).map((j) => `secbank-rule-burn-${j}`)])
    report(`remove rule ${id}`, await kb("DELETE", `/api/alerting/rule/${id}`), [204, 404])
  for (const j of Object.keys(JOURNEYS)) report(`remove SLO ${sloId(j)}`, await kb("DELETE", `/api/observability/slos/${sloId(j)}`), [204, 404])
  process.exit(failed ? 1 : 0)
}

/** Create, or update in place when it already exists (id fixed, so re-runs never duplicate). */
async function upsertRule(id, rule) {
  const r = await kb("POST", `/api/alerting/rule/${id}`, rule)
  if (r.status !== 409) return report(`rule ${id}`, r)
  const { rule_type_id, consumer, ...update } = rule
  return report(`rule ${id} (updated)`, await kb("PUT", `/api/alerting/rule/${id}`, update))
}

for (const [j, def] of Object.entries(JOURNEYS)) {
  const body = slo(j, def)
  const r = await kb("POST", "/api/observability/slos", { id: sloId(j), ...body })
  if (r.status === 409) report(`SLO ${sloId(j)} (updated)`, await kb("PUT", `/api/observability/slos/${sloId(j)}`, body))
  else report(`SLO ${sloId(j)}`, r)
  await upsertRule(`secbank-rule-burn-${j}`, burnRule(j, def[0]))
}
for (const [id, rule] of Object.entries(RULES)) await upsertRule(id, rule)

for (const [id, m] of Object.entries(ML)) {
  const job = { description: `SecBank: ${m.desc}`, groups: ["secbank"], analysis_config: m.analysis,
    data_description: { time_field: "@timestamp" }, model_plot_config: { enabled: true }, results_index_name: "secbank" }
  const r = await es("PUT", `/_ml/anomaly_detectors/${id}`, job)
  const exists = (x) => [400, 409].includes(x.status) && /already[ _]exists/.test(JSON.stringify(x.json))
  if (exists(r)) console.log(`ok   ML job ${id} (exists)`)
  else report(`ML job ${id}`, r)
  const df = await es("PUT", `/_ml/datafeeds/datafeed-${id}`, { job_id: id, indices: [m.index], query: m.query })
  if (exists(df)) console.log(`ok   datafeed ${id} (exists)`)
  else report(`datafeed ${id}`, df)
  report(`open ${id}`, await es("POST", `/_ml/anomaly_detectors/${id}/_open`), [200, 409])
  const st = await es("POST", `/_ml/datafeeds/datafeed-${id}/_start`, { start: "now-7d" })
  report(`start datafeed ${id}`, st, [200, 409])
}
if (args.includes("--forecast"))
  report("forecast secbank-pod-memory (1 day)", await es("POST", "/_ml/anomaly_detectors/secbank-pod-memory/_forecast", { duration: "1d" }))

console.log(failed ? `\n${failed} step(s) failed` : "\nall SecBank Kibana objects in place")
process.exit(failed ? 1 : 0)
