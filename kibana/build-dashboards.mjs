// Generates kibana/tensai-dashboards.ndjson — import via Kibana →
// Stack Management → Saved Objects → Import.  Run: node kibana/build-dashboards.mjs
//
// Contents: 5 data views (4 business indices from bin/export-to-elastic.php +
// traces-apm*), Lens visualizations, saved searches, and 2 dashboards:
//   1. Tensai SecBank — Business Overview   (Postgres data exported to ES)
//   2. Tensai SecBank — Real-time APM       (PHP agent + RUM traces)
// Rates and ms latencies come from data-view runtime fields (no Lens formulas),
// which keeps the objects simple and import-safe across Kibana 8.x / 9.x.
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const MIG = { coreMigrationVersion: "8.8.0", managed: false }
const L = "layer1"
const C = { blue: "#6092C0", green: "#54B399", red: "#E7664C", amber: "#D6BF57", purple: "#9170B8", teal: "#6DCCB1" }
const fmt = {
  int: { id: "number", params: { decimals: 0 } },
  num: { id: "number", params: { decimals: 2 } },
  ms: { id: "number", params: { decimals: 0, suffix: " ms" } },
  pct: { id: "percent", params: { decimals: 1 } },
}

// ---------- data views ----------
/** Painless runtime field: 1 when `field` equals `value`, else 0 (missing → no value). */
const outcomeFlag = (field, value) =>
  `if (doc.containsKey('${field}') && doc['${field}'].size() != 0) { emit(doc['${field}'].value == '${value}' ? 1 : 0); }`

const DV = {
  txn: { id: "tensai-dv-transactions", title: "tensai-transactions", name: "Tensai · Transactions",
    runtime: { txn_success: { type: "long", script: { source: outcomeFlag("status", "COMPLETED") } } } },
  users: { id: "tensai-dv-users", title: "tensai-users", name: "Tensai · Users" },
  logins: { id: "tensai-dv-login-events", title: "tensai-login-events", name: "Tensai · Login events",
    runtime: { login_failed: { type: "long", script: { source: outcomeFlag("outcome", "failure") } } } },
  accounts: { id: "tensai-dv-accounts", title: "tensai-accounts", name: "Tensai · Accounts" },
  apm: { id: "tensai-dv-apm-traces", title: "traces-apm*", name: "Tensai · APM traces",
    runtime: {
      apm_failed: { type: "long", script: { source: outcomeFlag("event.outcome", "failure") } },
      latency_ms: { type: "double", script: { source:
        "if (doc.containsKey('transaction.duration.us') && doc['transaction.duration.us'].size() != 0) { emit(doc['transaction.duration.us'].value / 1000.0); }" } },
    } },
}

const dataView = (d) => ({
  id: d.id, type: "index-pattern", ...MIG, typeMigrationVersion: "8.0.0", references: [],
  attributes: { title: d.title, name: d.name, timeFieldName: "@timestamp", allowNoIndex: true, fields: "[]",
    fieldFormatMap: "{}", runtimeFieldMap: JSON.stringify(d.runtime || {}), sourceFilters: "[]" },
})

// ---------- Lens columns ----------
const count = (label, kql) => ({
  label, customLabel: true, dataType: "number", operationType: "count", isBucketed: false, scale: "ratio",
  sourceField: "___records___", params: { emptyAsNull: false, format: fmt.int }, // 0, not "N/A"
  ...(kql ? { filter: { language: "kuery", query: kql } } : {}),
})
const agg = (op, field, label, format = fmt.num, extra = {}) => ({
  label, customLabel: true, dataType: "number", operationType: op, isBucketed: false, scale: "ratio",
  sourceField: field, params: { emptyAsNull: true, format, ...extra },
})
const lastSeen = (label) => ({
  label, customLabel: true, dataType: "date", operationType: "last_value", isBucketed: false, scale: "ratio",
  sourceField: "@timestamp", params: { sortField: "@timestamp", showArrayValues: false },
})
const terms = (field, label, size, orderBy, other = false) => ({
  label, customLabel: true, dataType: "string", operationType: "terms", sourceField: field, isBucketed: true, scale: "ordinal",
  params: { size, orderBy: { type: "column", columnId: orderBy }, orderDirection: "desc", otherBucket: other, missingBucket: false,
    parentFormat: { id: "terms" }, include: [], exclude: [], includeIsRegex: false, excludeIsRegex: false },
})
const dateHist = () => ({
  label: "@timestamp", dataType: "date", operationType: "date_histogram", sourceField: "@timestamp", isBucketed: true, scale: "interval",
  params: { interval: "auto", includeEmptyRows: true, dropPartials: false },
})

// ---------- Lens visualizations ----------
function lens(id, title, dv, visualizationType, columns, columnOrder, visualization, query = "") {
  return {
    id, type: "lens", ...MIG, typeMigrationVersion: "8.9.0",
    attributes: { title, description: "", visualizationType, state: {
      datasourceStates: {
        formBased: { layers: { [L]: { columns, columnOrder, incompleteColumns: {}, sampling: 1 } } },
        indexpattern: { layers: {} }, textBased: { layers: {} },
      },
      visualization, query: { query, language: "kuery" }, filters: [], internalReferences: [], adHocDataViews: {},
    } },
    references: [{ type: "index-pattern", id: DV[dv].id, name: `indexpattern-datasource-layer-${L}` }],
  }
}

const xyVis = (seriesType, xAccessor, accessors, colors = {}, legend = "bottom") => ({
  legend: { isVisible: true, position: legend }, valueLabels: "hide", fittingFunction: "Linear", preferredSeriesType: seriesType,
  axisTitlesVisibilitySettings: { x: false, yLeft: false, yRight: false },
  tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true },
  gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
  layers: [{ layerId: L, layerType: "data", seriesType, xAccessor, accessors, position: "top", showGridlines: false,
    yConfig: Object.entries(colors).map(([forAccessor, color]) => ({ forAccessor, color })) }],
})

const metric = (id, title, dv, col, query = "", subtitle) =>
  lens(id, title, dv, "lnsMetric", { m: col }, ["m"],
    { layerId: L, layerType: "data", metricAccessor: "m", ...(subtitle ? { subtitle } : {}) }, query)

/** Time series; series = [{ id, col, color }]. */
function timeSeries(id, title, dv, series, { query = "", type = "bar_stacked" } = {}) {
  const columns = { x: dateHist() }
  for (const s of series) columns[s.id] = s.col
  const colors = Object.fromEntries(series.filter((s) => s.color).map((s) => [s.id, s.color]))
  return lens(id, title, dv, "lnsXY", columns, ["x", ...series.map((s) => s.id)],
    xyVis(type, "x", series.map((s) => s.id), colors), query)
}

const topBar = (id, title, dv, field, groupLabel, valueCol, { size = 10, query = "", color = C.blue } = {}) =>
  lens(id, title, dv, "lnsXY", { g: terms(field, groupLabel, size, "v"), v: valueCol }, ["g", "v"],
    xyVis("bar_horizontal", "g", ["v"], { v: color }, "right"), query)

const donut = (id, title, dv, field, groupLabel, valueCol, { size = 8, query = "" } = {}) =>
  lens(id, title, dv, "lnsPie", { g: terms(field, groupLabel, size, "v", true), v: valueCol }, ["g", "v"], {
    shape: "donut",
    layers: [{ layerId: L, layerType: "data", primaryGroups: ["g"], metrics: ["v"], numberDisplay: "percent",
      categoryDisplay: "default", legendDisplay: "show", nestedLegend: false }],
  }, query)

/** Table; cols = [[id, column], ...] — first is the row grouping. */
const table = (id, title, dv, cols, sortBy, query = "") =>
  lens(id, title, dv, "lnsDatatable", Object.fromEntries(cols), cols.map(([c]) => c), {
    layerId: L, layerType: "data", columns: cols.map(([columnId]) => ({ columnId, isTransposed: false })),
    sorting: { columnId: sortBy, direction: "desc" },
  }, query)

// ---------- saved searches (raw-row panels) ----------
const search = (id, title, dv, columns, query = "") => ({
  id, type: "search", ...MIG, typeMigrationVersion: "8.0.0",
  attributes: { title, description: "", columns, sort: [["@timestamp", "desc"]], grid: {}, hideChart: true, isTextBasedQuery: false,
    kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query, language: "kuery" }, filter: [],
      indexRefName: "kibanaSavedObjectMeta.searchSourceJSON.index" }) } },
  references: [{ name: "kibanaSavedObjectMeta.searchSourceJSON.index", type: "index-pattern", id: DV[dv].id }],
})

// ---------- dashboards ----------
/** rows = [[height, [obj, width], [obj, width], ...], ...] laid out on Kibana's 48-column grid. */
function dashboard(id, title, description, rows, { from, refreshMs }) {
  const panels = []
  let y = 0
  for (const [h, ...cells] of rows) {
    let x = 0
    for (const [obj, w] of cells) { panels.push({ obj, x, y, w, h }); x += w }
    if (x !== 48) throw new Error(`${title}: row at y=${y} is ${x}/48 wide`)
    y += h
  }
  const panelsJSON = panels.map((p, i) => ({
    version: "8.9.0", type: p.obj.type, gridData: { x: p.x, y: p.y, w: p.w, h: p.h, i: `p${i}` },
    panelIndex: `p${i}`, embeddableConfig: { enhancements: {} }, panelRefName: `panel_p${i}`,
  }))
  return {
    id, type: "dashboard", ...MIG, typeMigrationVersion: "8.9.0",
    attributes: { title, description, timeRestore: true, timeFrom: from, timeTo: "now",
      refreshInterval: refreshMs ? { pause: false, value: refreshMs } : { pause: true, value: 60000 },
      optionsJSON: JSON.stringify({ useMargins: true, syncColors: true, syncCursor: true, syncTooltips: true, hidePanelTitles: false }),
      panelsJSON: JSON.stringify(panelsJSON),
      kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: "", language: "kuery" }, filter: [] }) } },
    references: panels.map((p, i) => ({ name: `p${i}:panel_p${i}`, type: p.obj.type, id: p.obj.id })),
  }
}

// =====================================================================
// Dashboard 1 — Business Overview (exported Postgres data)
// =====================================================================
const LOGIN_OK = 'event : "login" and outcome : "success"'
const LOGIN_FAIL = 'event : "login" and outcome : "failure"'

const b = {
  totalTxn: metric("tensai-b-total-txn", "Total Transactions", "txn", count("Transactions")),
  volume: metric("tensai-b-volume", "Transaction Volume", "txn", agg("sum", "amount", "Volume ($)")),
  txnSuccess: metric("tensai-b-success", "Transaction Success Rate", "txn", agg("average", "txn_success", "Success rate", fmt.pct), "", "status = COMPLETED"),
  // Distinct customers who logged in during the selected time range (live, follows activity).
  customers: metric("tensai-b-customers", "Active Customers", "logins", agg("unique_count", "user_id", "Customers", fmt.int), LOGIN_OK),
  logins: metric("tensai-b-logins", "Successful Logins", "logins", count("Logins"), LOGIN_OK),
  failedLogins: metric("tensai-b-failed-logins", "Failed Logins", "logins", count("Failed logins"), LOGIN_FAIL),

  txnTrend: timeSeries("tensai-b-txn-trend", "Transaction Volume & Status", "txn", [
    { id: "ok", col: count("Completed", 'status : "COMPLETED"'), color: C.blue },
    { id: "bad", col: count("Failed / pending / reversed", 'not status : "COMPLETED"'), color: C.red },
  ]),
  byType: donut("tensai-b-by-type", "Transactions by Type", "txn", "category", "Category", count("Transactions")),

  loginTrend: timeSeries("tensai-b-login-trend", "Logins Over Time", "logins", [
    { id: "ok", col: count("Successful", LOGIN_OK), color: C.green },
    { id: "bad", col: count("Failed", LOGIN_FAIL), color: C.red },
    { id: "reg", col: count("New registrations", 'event : "register"'), color: C.purple },
  ]),
  topCustomers: table("tensai-b-top-customers", "Top Customers by Transactions", "txn", [
    ["g", terms("from_user", "Customer", 10, "n")],
    ["n", count("Transactions")],
    ["amt", agg("sum", "amount", "Volume ($)")],
    ["avg", agg("average", "amount", "Avg amount ($)")],
  ], "n", "not self_transfer : true"),

  loginActivity: table("tensai-b-login-activity", "User Login Activity (count + last login)", "logins", [
    ["g", terms("username", "User", 20, "n")],
    ["n", count("Successful logins", LOGIN_OK)],
    ["f", count("Failed attempts", LOGIN_FAIL)],
    ["last", lastSeen("Last activity")],
  ], "n"),
  recentLogins: search("tensai-b-recent-logins", "Recent Login Events", "logins", ["username", "event", "outcome", "method", "email", "ip"]),

  amountByCat: topBar("tensai-b-amount-by-cat", "Volume by Category", "txn", "category", "Category", agg("sum", "amount", "Volume ($)"), { color: C.teal }),
  recentTxn: search("tensai-b-recent-txn", "Recent Transactions", "txn", ["from_user", "to_user", "amount", "category", "status", "description"]),

  accountsByKind: donut("tensai-b-accounts-kind", "Accounts by Type", "accounts", "kind", "Account type", count("Accounts")),
  topBalances: table("tensai-b-top-balances", "Top Customers by Balance", "accounts", [
    ["g", terms("user_name", "Customer", 10, "bal")],
    ["bal", agg("sum", "balance", "Balance ($)")],
    ["n", count("Accounts")],
  ], "bal", 'status : "ACTIVE"'),
  newCustomers: timeSeries("tensai-b-new-customers", "New Customers", "users",
    [{ id: "n", col: count("Registrations"), color: C.purple }], { query: "not is_system_user : true", type: "bar" }),
}

const dash1 = dashboard("tensai-dashboard-business", "Tensai SecBank — Business Overview",
  "Customers, transactions, accounts and logins exported from Postgres (bin/export-to-elastic.php).", [
    [6, [b.totalTxn, 8], [b.volume, 8], [b.txnSuccess, 8], [b.customers, 8], [b.logins, 8], [b.failedLogins, 8]],
    [13, [b.txnTrend, 32], [b.byType, 16]],
    [12, [b.loginTrend, 24], [b.topCustomers, 24]],
    [14, [b.loginActivity, 24], [b.recentLogins, 24]],
    [12, [b.amountByCat, 24], [b.recentTxn, 24]],
    [12, [b.accountsByKind, 14], [b.topBalances, 18], [b.newCustomers, 16]],
  ], { from: "now-1y" })

// =====================================================================
// Dashboard 2 — Real-time APM (PHP agent + browser RUM)
// =====================================================================
const API = 'service.name : "tensai-secbank-api" and processor.event : "transaction"'
const WEB = 'service.name : "tensai-secbank-web" and processor.event : "transaction"'
const PAGE = `${WEB} and transaction.type : "page-load"`

const a = {
  requests: metric("tensai-a-requests", "API Requests", "apm", count("Requests"), API),
  failRate: metric("tensai-a-fail-rate", "Failure Rate", "apm", agg("average", "apm_failed", "Failure rate", fmt.pct), API),
  failed: metric("tensai-a-failed", "Failed Requests", "apm", count("Failed", 'event.outcome : "failure"'), API),
  avgLatency: metric("tensai-a-avg-latency", "Avg Response Time", "apm", agg("average", "latency_ms", "Avg (ms)", fmt.ms), API),
  p95Latency: metric("tensai-a-p95-latency", "P95 Response Time", "apm", agg("percentile", "latency_ms", "P95 (ms)", fmt.ms, { percentile: 95 }), API),
  activeUsers: metric("tensai-a-active-users", "Active Users", "apm", agg("unique_count", "labels.username", "Users", fmt.int), API),

  successVsFailed: timeSeries("tensai-a-success-failed", "Successful vs Failed Requests", "apm", [
    { id: "ok", col: count("Successful", 'event.outcome : "success"'), color: C.green },
    { id: "bad", col: count("Failed", 'event.outcome : "failure"'), color: C.red },
  ], { query: API, type: "line" }),
  httpResults: donut("tensai-a-http-results", "HTTP Results", "apm", "transaction.result", "Result", count("Requests"), { query: API }),

  latencyTrend: timeSeries("tensai-a-latency-trend", "Response Time (avg / p95)", "apm", [
    { id: "avg", col: agg("average", "latency_ms", "Avg (ms)", fmt.ms), color: C.blue },
    { id: "p95", col: agg("percentile", "latency_ms", "P95 (ms)", fmt.ms, { percentile: 95 }), color: C.amber },
  ], { query: API, type: "line" }),
  failureReasons: topBar("tensai-a-failure-reasons", "Top Failure Reasons", "apm", "labels.failure_reason", "Reason",
    count("Failures"), { query: `${API} and event.outcome : "failure"`, color: C.red }),

  endpoints: table("tensai-a-endpoints", "Endpoint Health", "apm", [
    ["g", terms("transaction.name", "Endpoint", 25, "n")],
    ["n", count("Requests")],
    ["avg", agg("average", "latency_ms", "Avg (ms)", fmt.ms)],
    ["p95", agg("percentile", "latency_ms", "P95 (ms)", fmt.ms, { percentile: 95 })],
    ["fr", agg("average", "apm_failed", "Failure rate", fmt.pct)],
    ["f", count("Failed", 'event.outcome : "failure"')],
  ], "n", API),

  loginsByUser: table("tensai-a-logins-by-user", "Logins by User (live)", "apm", [
    ["g", terms("labels.username", "User", 20, "n")],
    ["n", count("Successful logins", 'labels.auth_outcome : "success"')],
    ["f", count("Failed attempts", 'labels.auth_outcome : "failure"')],
    ["last", lastSeen("Last login")],
  ], "n", `${API} and labels.auth_event : "login"`),
  recentFailures: search("tensai-a-recent-failures", "Recent Failed Requests", "apm",
    ["transaction.name", "transaction.result", "labels.username", "labels.failure_reason", "transaction.duration.us"],
    `${API} and event.outcome : "failure"`),

  pageLoads: topBar("tensai-a-page-loads", "Browser: Page Loads by Page", "apm", "transaction.name", "Page",
    count("Page loads"), { query: PAGE, color: C.purple }),
  browsers: donut("tensai-a-browsers", "Browser: Clients", "apm", "user_agent.name", "Browser", count("Sessions"), { query: WEB }),
  pageLoadTime: metric("tensai-a-page-load-time", "Avg Page Load", "apm", agg("average", "latency_ms", "Page load (ms)", fmt.ms), PAGE),
  lcp: metric("tensai-a-lcp", "Avg LCP", "apm", agg("average", "transaction.marks.agent.largestContentfulPaint", "LCP (ms)", fmt.ms), PAGE),
}

const dash2 = dashboard("tensai-dashboard-apm", "Tensai SecBank — Real-time APM",
  "Live requests, latency, failures and logins from the Elastic APM PHP agent (tensai-secbank-api) and browser RUM (tensai-secbank-web).", [
    [6, [a.requests, 8], [a.failRate, 8], [a.failed, 8], [a.avgLatency, 8], [a.p95Latency, 8], [a.activeUsers, 8]],
    [13, [a.successVsFailed, 32], [a.httpResults, 16]],
    [12, [a.latencyTrend, 24], [a.failureReasons, 24]],
    [14, [a.endpoints, 48]],
    [14, [a.loginsByUser, 24], [a.recentFailures, 24]],
    [6, [a.pageLoadTime, 12], [a.lcp, 12], [a.browsers, 24]],
    [10, [a.pageLoads, 48]],
  ], { from: "now-24h", refreshMs: 30000 })

// ---------- write + self-check ----------
const objects = [...Object.values(DV).map(dataView), ...Object.values(b), ...Object.values(a), dash1, dash2]
const ids = new Set(objects.map((o) => `${o.type}:${o.id}`))
if (ids.size !== objects.length) throw new Error("duplicate saved-object id")
for (const o of objects)
  for (const r of o.references)
    if (!ids.has(`${r.type}:${r.id}`)) throw new Error(`${o.id} → missing ${r.type}:${r.id}`)
for (const d of [dash1, dash2]) {
  const names = new Set(d.references.map((r) => r.name))
  for (const p of JSON.parse(d.attributes.panelsJSON))
    if (!names.has(`${p.panelIndex}:${p.panelRefName}`)) throw new Error(`${d.id}: panel ${p.panelIndex} has no reference`)
}

const write = (file, objs) => {
  const out = fileURLToPath(new URL(file, import.meta.url))
  writeFileSync(out, objs.map((o) => JSON.stringify(o)).join("\n") + "\n")
  console.log(`wrote ${objs.length} saved objects → ${out}`)
}
write("./tensai-dashboards.ndjson", objects)
// Same objects minus the dashboards: re-importing this updates every panel in
// place without overwriting layout changes made to the dashboards in Kibana.
write("./tensai-panels-update.ndjson", objects.filter((o) => o.type !== "dashboard"))
