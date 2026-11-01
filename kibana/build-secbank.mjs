// Generates kibana/secbank-dashboards.ndjson: the SecBank D0-D9 dashboards (spec: 1-SecBank-Dashboards.html,
// 3-SecBank-Build-Pack.html "Every panel"). Import: Stack Management -> Saved Objects -> Import.
// All ids start with "secbank-", so importing never touches the existing Tensai dashboards.
//
//   node kibana/build-secbank.mjs                      write the NDJSON
//   node kibana/build-secbank.mjs --check [ES_URL]     also run every ES|QL query against Elasticsearch
//                                                      (?_tstart/?_tend bound to --from/--to, default last 60 min)
//
// Data: logs-bank.* / metrics-bank.* / bank-* (api/bin/setup-elastic.php, simulate.php, journey-health.php)
// and traces-apm* (simulated microservices + the PHP agent). Panels are ES|QL Lens charts unless the spec
// needs Vega (heatmaps, funnel, bubble, confusion matrix) or a map.
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const MIG = { coreMigrationVersion: "8.8.0", managed: false }
const L = "layer1"
// Spec palette (wireframes): healthy / watch / critical, plus neutrals.
const COL = { good: "#209280", watch: "#D6BF57", bad: "#CC5642", blue: "#6092C0", grey: "#98A2B3", purple: "#9170B8" }

// ---------- shared ES|QL fragments ----------
const BIZ = "logs-bank.business-default"
// KPIs exclude load-test users of the real app (traffic.php); simulator and real customers are both shown.
const NOLOAD = 'NOT (labels.data_source == "app" AND labels.synthetic_user == true)'
const TERMINAL = 'journey.status IN ("completed", "failed", "abandoned", "pending")'
const END = "TO_DATETIME(?_tend)"
const last = (min) => `@timestamp >= ${END} - ${min} minutes`
// Journey Health Index from the additive counts in bank-journey-health (same formula as journey-health.php).
const JHI = `| STATS n = SUM(health.attempts), done = SUM(health.completed), tech = SUM(health.tech_failures), sat = SUM(health.satisfied),
    tol = SUM(health.tolerating), pv = SUM(health.page_views), pvok = SUM(health.page_views_pass), slo = MAX(health.slo_completion_pct) BY journey.name
  | EVAL c = LEAST(1.0, (TO_DOUBLE(done) / n) / (slo / 100.0)), a = (sat + tol / 2.0) / n, e = GREATEST(0.0, 1 - (TO_DOUBLE(tech) / n) / 0.05),
    x = CASE(pv > 0, TO_DOUBLE(pvok) / pv, 1.0), jhi = ROUND(100 * (0.4 * c + 0.25 * a + 0.2 * e + 0.15 * x), 0)`
const IMPACTED = `| LOOKUP JOIN bank-journey-steps ON journey.step_key
  | WHERE journey.failure_class == "technical" OR journey.step_duration_ms > journey.step_target_ms`

// ---------- objects ----------
const objects = []
const add = (o) => (objects.push(o), o)
const adhocId = (index) => "secbank-esql-" + createHash("md5").update(index).digest("hex").slice(0, 12)
const indexOf = (q) => q.match(/^\s*FROM\s+([^|\s]+(?:\s*,\s*[^|\s]+)*)/i)[1].replace(/\s+/g, "")

/** Column label shown in Kibana: "impact.value_at_risk" -> "Value at risk". */
const human = (name) => {
  const s = name.split(".").pop().replace(/_pct$/, " %").replace(/_/g, " ")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * ES|QL Lens panel. cols = [[name, type, label?]] in output order; vis = how to draw them:
 *   { metric: v [, secondary] } | { xy: "line"|"area"|"bar"|"bar_horizontal"|"bar_stacked"|"area_stacked", x, y: [..], split }
 *   | { table: true } | { pie: g, value: v }
 */
function esql(id, title, query, cols, vis, { description = "", colors = {}, time = true } = {}) {
  query = query.replace(/\s*\n\s*/g, " ").trim()
  const index = indexOf(query)
  const dv = adhocId(index)
  const columns = cols.map(([name, type, label]) => ({ columnId: name, fieldName: name, label: label ?? (name === vis.secondary ? "" : human(name)), customLabel: true, meta: { type } }))
  let visualizationType, visualization
  if (vis.metric) {
    visualizationType = "lnsMetric"
    visualization = { layerId: L, layerType: "data", metricAccessor: vis.metric,
      ...(vis.secondary ? { secondaryMetricAccessor: vis.secondary, secondaryPrefix: "" } : {}), ...(vis.color ? { color: vis.color } : {}),
      ...(vis.palette ? { palette: vis.palette } : {}) }
  } else if (vis.xy) {
    visualizationType = "lnsXY"
    visualization = {
      legend: { isVisible: !!vis.split || vis.y.length > 1, position: "bottom" }, valueLabels: vis.labels ? "show" : "hide",
      fittingFunction: "None", preferredSeriesType: vis.xy, axisTitlesVisibilitySettings: { x: false, yLeft: false, yRight: false },
      tickLabelsVisibilitySettings: { x: true, yLeft: true, yRight: true }, gridlinesVisibilitySettings: { x: true, yLeft: true, yRight: true },
      layers: [{ layerId: L, layerType: "data", seriesType: vis.xy, xAccessor: vis.x, accessors: vis.y, ...(vis.split ? { splitAccessor: vis.split } : {}),
        yConfig: Object.entries(colors).map(([forAccessor, color]) => ({ forAccessor, color })) }],
    }
  } else if (vis.pie) {
    visualizationType = "lnsPie"
    visualization = { shape: "donut", layers: [{ layerId: L, layerType: "data", primaryGroups: [vis.pie], metrics: [vis.value],
      numberDisplay: "value", categoryDisplay: "default", legendDisplay: "show", nestedLegend: false }] }
  } else {
    visualizationType = "lnsDatatable"
    visualization = { layerId: L, layerType: "data", columns: cols.map(([columnId]) => ({ columnId, isTransposed: false,
      ...(vis.colorBy?.[columnId] ? { colorMode: "cell", palette: vis.colorBy[columnId] } : {}) })) }
  }
  return add({
    id, type: "lens", ...MIG, typeMigrationVersion: "8.9.0", _esql: { query, cols, time },
    attributes: { title, description, visualizationType, state: {
      datasourceStates: { textBased: { layers: { [L]: { index: dv, query: { esql: query }, columns, ...(time ? { timeField: "@timestamp" } : {}) } } } },
      visualization, query: { esql: query }, filters: [], internalReferences: [], needsRefresh: false,
      adHocDataViews: { [dv]: { id: dv, title: index, name: index, ...(time ? { timeFieldName: "@timestamp" } : {}), sourceFilters: [], fieldFormats: {},
        runtimeFieldMap: {}, fieldAttrs: {}, allowNoIndex: true, type: "esql" } },
    } },
    references: [],
  })
}

// Lens palette: red / amber / green by thresholds on a 0..100 (or ratio) value.
const bands = (stops, colors = [COL.bad, COL.watch, COL.good], max = 100) => ({ type: "palette", name: "custom", params: {
  name: "custom", reverse: false, rangeType: "number", rangeMin: 0, rangeMax: max, progression: "fixed", continuity: "above",
  stops: colors.map((color, i) => ({ color, stop: stops[i] })), colorStops: colors.map((color, i) => ({ color, stop: i ? stops[i - 1] : 0 })) } })

const markdown = (id, title, md) => add({
  id, type: "visualization", ...MIG, typeMigrationVersion: "8.5.0", references: [],
  attributes: { title, description: "", uiStateJSON: "{}", version: 1,
    visState: JSON.stringify({ title, type: "markdown", aggs: [], params: { markdown: md, fontSize: 12, openLinksInNewTab: false } }),
    kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: "", language: "kuery" }, filter: [] }) } },
})

/** Vega-Lite panel. spec is an object; Kibana's %context% / %timefield% make it follow dashboard filters and time. */
const vega = (id, title, spec) => add({
  id, type: "visualization", ...MIG, typeMigrationVersion: "8.5.0", references: [],
  attributes: { title, description: "", uiStateJSON: "{}", version: 1,
    visState: JSON.stringify({ title, type: "vega", aggs: [], params: { spec: JSON.stringify(spec, null, 2) } }),
    kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: "", language: "kuery" }, filter: [] }) } },
})

// ---------- data views (controls, saved searches, map, annotations) ----------
const DV = {}
const dataView = (key, id, title, name) => (DV[key] = add({
  id, type: "index-pattern", ...MIG, typeMigrationVersion: "8.0.0", references: [],
  attributes: { title, name, timeFieldName: "@timestamp", allowNoIndex: true, fields: "[]", fieldFormatMap: "{}", runtimeFieldMap: "{}", sourceFilters: "[]" },
}))
dataView("biz", "secbank-dv-business", "logs-bank.business-*", "SecBank · Business events")
dataView("health", "secbank-dv-health", "bank-journey-health", "SecBank · Journey health")
dataView("problems", "secbank-dv-problems", "bank-problems", "SecBank · Problems")
dataView("platform", "secbank-dv-platform", "metrics-bank.platform-*", "SecBank · Platform metrics")
dataView("app", "secbank-dv-app", "logs-bank.app-*", "SecBank · Service logs")
dataView("synth", "secbank-dv-synth", "logs-bank.synthetics-*", "SecBank · Synthetic monitors")
dataView("risks", "secbank-dv-risks", "bank-risks", "SecBank · Risks")
dataView("ai", "secbank-dv-ai", "bank-ai-scores", "SecBank · AI scoring")
dataView("apm", "secbank-dv-apm", "traces-apm*", "SecBank · APM traces")

const search = (id, title, dv, columns, query, sortField = "@timestamp") => add({
  id, type: "search", ...MIG, typeMigrationVersion: "8.0.0",
  attributes: { title, description: "", columns, sort: [[sortField, "desc"]], grid: {}, hideChart: true, isTextBasedQuery: false,
    kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query, language: "kuery" }, filter: [],
      indexRefName: "kibanaSavedObjectMeta.searchSourceJSON.index" }) } },
  references: [{ name: "kibanaSavedObjectMeta.searchSourceJSON.index", type: "index-pattern", id: DV[dv].id }],
})

// ---------- dashboards ----------
const TITLES = ["Bank Pulse", "Journeys", "Branches", "Customer Lens", "Experience", "Services", "Platform", "Incident Room", "Preventive Watch", "AI Accountability"]
const dashId = (i) => `secbank-d${i}`
// Links panel, identical on all ten dashboards; each link keeps time range and filters.
const links = add({
  id: "secbank-links", type: "links", ...MIG, typeMigrationVersion: "10.1.0",
  attributes: { title: "SecBank navigation", description: "", layout: "horizontal",
    links: TITLES.map((label, i) => ({ id: `l${i}`, type: "dashboardLink", order: i, label, destinationRefName: `link_l${i}_dashboard`,
      options: { openInNewTab: false, useCurrentDateRange: true, useCurrentFilters: true } })) },
  references: TITLES.map((_, i) => ({ name: `link_l${i}_dashboard`, type: "dashboard", id: dashId(i) })),
})

/** Options list controls on a data view field: [[dvKey, field, title, preselected?], ...]. */
function controls(list) {
  const panels = {}
  const refs = []
  list.forEach(([dv, field, title, selected = []], i) => {
    const id = `c${i}`
    panels[id] = { order: i, width: "small", grow: true, type: "optionsListControl",
      explicitInput: { id, fieldName: field, title, searchTechnique: "prefix", selectedOptions: selected, singleSelect: false } }
    refs.push({ name: `controlGroup_${id}:optionsListDataView`, type: "index-pattern", id: DV[dv].id })
  })
  return { input: { chainingSystem: "HIERARCHICAL", controlStyle: "oneLine", showApplySelections: false,
    ignoreParentSettingsJSON: JSON.stringify({ ignoreFilters: false, ignoreQuery: false, ignoreTimerange: false, ignoreValidations: false }),
    panelsJSON: JSON.stringify(panels) }, refs }
}

/** rows = [[height, [obj, width], ...], ...] on Kibana's 48-column grid. The links panel is added on top. */
function dashboard(i, description, rows, ctl = [], timeFrom = "now-60m") {
  const id = dashId(i)
  const title = `SecBank D${i} · ${TITLES[i]}`
  const panels = []
  let y = 0
  for (const [h, ...cells] of [[3, [links, 48]], ...rows]) {
    let x = 0
    for (const [obj, w] of cells) { panels.push({ obj, x, y, w, h }); x += w }
    if (x !== 48) throw new Error(`${title}: row at y=${y} is ${x}/48 wide`)
    y += h
  }
  const c = controls(ctl)
  return add({
    id, type: "dashboard", ...MIG, typeMigrationVersion: "8.9.0",
    attributes: { title, description, timeRestore: true, timeFrom, timeTo: "now", refreshInterval: { pause: false, value: 30000 },
      optionsJSON: JSON.stringify({ useMargins: true, syncColors: true, syncCursor: true, syncTooltips: true, hidePanelTitles: false }),
      panelsJSON: JSON.stringify(panels.map((p, k) => ({ version: "8.9.0", type: p.obj.type, gridData: { x: p.x, y: p.y, w: p.w, h: p.h, i: `p${k}` },
        panelIndex: `p${k}`, embeddableConfig: { enhancements: {} }, panelRefName: `panel_p${k}` }))),
      ...(ctl.length ? { controlGroupInput: c.input } : {}),
      kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: "", language: "kuery" }, filter: [] }) } },
    references: [...panels.map((p, k) => ({ name: `p${k}:panel_p${k}`, type: p.obj.type, id: p.obj.id })), ...c.refs],
  })
}

const DEFINITIONS = `**Simulated bank data** (labels.data_source = simulator) plus real customers of the app. Not a Tensai value claim.

| Term | Definition |
|---|---|
| Journey attempt | One journey instance (journey.id); completion = completed over attempts (completed, failed, abandoned, pending). |
| Customer impacted | Distinct pseudonymous ref (bank.customer.ref) with a technical failure or a step beyond its target, last 15 min. |
| Value at risk | Amounts of journeys that failed technically, plus amounts pending past the 15 min SLA. |
| Journey health index | 100 x (0.40 C + 0.25 A + 0.20 E + 0.15 X); healthy 90+, watch 80-89, critical below 80. bank-journey-health, every minute. |
| C, completion | Completion over the journey's SLO target, capped at 1. |
| A, Apdex | T = half the journey's p95 target (bill pay 10 s): satisfied up to T, tolerating up to 4T, frustrated above or failed. |
| E, errors | 1 minus technical failure share over a 5 % ceiling, floored at 0. |
| X, experience | Share of page views passing LCP 2.5 s, INP 200 ms and CLS 0.1. |
| Customer-impact minutes | Per minute, distinct impacted customers; summed. |
| Problems | Detected from signals every minute (bank-problems); severity first, then value at risk. |`

// =====================================================================
// D0 Bank Pulse
// =====================================================================
const d0 = {
  // Healthy = index 90+ AND no open problem attached (a quietly failing journey can keep a green index: autopay, S9).
  healthy: esql("secbank-d0-healthy", "Journeys healthy", `FROM bank-journey-health, bank-problems
    | WHERE (health.attempts IS NOT NULL AND ${last(10)}) OR problem.status == "open" | MV_EXPAND journey.name
    | STATS n = SUM(health.attempts), done = SUM(health.completed), tech = SUM(health.tech_failures), sat = SUM(health.satisfied),
      tol = SUM(health.tolerating), pv = SUM(health.page_views), pvok = SUM(health.page_views_pass), slo = MAX(health.slo_completion_pct),
      problems = SUM(CASE(problem.status == "open", 1, 0)) BY journey.name | WHERE n > 0
    | EVAL c = LEAST(1.0, (TO_DOUBLE(done) / n) / (slo / 100.0)), a = (sat + tol / 2.0) / n, e = GREATEST(0.0, 1 - (TO_DOUBLE(tech) / n) / 0.05),
      x = CASE(pv > 0, TO_DOUBLE(pvok) / pv, 1.0), jhi = ROUND(100 * (0.4 * c + 0.25 * a + 0.2 * e + 0.15 * x), 0)
    | EVAL ok = CASE(jhi >= 90 AND problems == 0, 1, 0) | STATS healthy = SUM(ok), journeys = COUNT(*)
    | EVAL label = CONCAT(TO_STRING(healthy), " of ", TO_STRING(journeys), " (index 90+, no open problem)") | KEEP healthy, label`,
    [["healthy", "number"], ["label", "string"]], { metric: "healthy", secondary: "label" }),
  impacted: esql("secbank-d0-impacted", "Customers impacted now", `FROM ${BIZ} | WHERE ${last(15)} AND event.category == "journey" AND ${NOLOAD} ${IMPACTED}
    | STATS customers = COUNT_DISTINCT(bank.customer.ref)`, [["customers", "number"]], { metric: "customers", color: COL.bad }),
  var: esql("secbank-d0-var", "Value at risk this hour", `FROM ${BIZ} | WHERE ${last(60)} AND event.category == "journey" AND ${NOLOAD}
    | EVAL v = CASE(journey.failure_class == "technical" AND journey.status == "failed", bank.txn.amount,
                    journey.status == "pending" AND @timestamp < ${END} - 15 minutes, bank.txn.amount, 0.0)
    | STATS value_at_risk = ROUND(SUM(v), 0)`, [["value_at_risk", "number"]], { metric: "value_at_risk", color: COL.bad }),
  completion: esql("secbank-d0-completion", "Journey completion", `FROM ${BIZ} | WHERE event.category == "journey" AND ${TERMINAL} AND ${NOLOAD}
    | STATS attempts = COUNT(*), completed = SUM(CASE(journey.status == "completed", 1, 0))
    | EVAL completion_pct = ROUND(100.0 * completed / attempts, 1), of = CONCAT(TO_STRING(completed), " of ", TO_STRING(attempts), " attempts")
    | KEEP completion_pct, of`, [["completion_pct", "number"], ["of", "string"]], { metric: "completion_pct", secondary: "of" }),
  cim: esql("secbank-d0-cim", "Customer-impact minutes", `FROM ${BIZ} | WHERE event.category == "journey" AND ${NOLOAD} ${IMPACTED}
    | STATS n = COUNT_DISTINCT(bank.customer.ref) BY m = BUCKET(@timestamp, 1 minute) | STATS customer_minutes = SUM(n)`,
    [["customer_minutes", "number"]], { metric: "customer_minutes" }),
  incidents: esql("secbank-d0-incidents", "Open business incidents", `FROM bank-problem-rank | WHERE kind == "summary" | SORT @timestamp DESC | LIMIT 1
    | EVAL detail = CONCAT(TO_STRING(summary.critical), " critical, ", TO_STRING(summary.major), " major, ", TO_STRING(summary.minor), " minor")
    | KEEP summary.open, detail`, [["summary.open", "number"], ["detail", "string"]], { metric: "summary.open", secondary: "detail" }),
  scorecard: esql("secbank-d0-scorecard", "Journey scorecard", `FROM bank-journey-health ${JHI}
    | EVAL completion_pct = ROUND(100.0 * done / n, 1), burn_rate = ROUND((1 - TO_DOUBLE(done) / n) / (1 - slo / 100.0), 1),
      status = CASE(jhi >= 90, "Healthy", jhi >= 80, "Watch", "Critical")
    | SORT jhi ASC | KEEP journey.name, jhi, n, completion_pct, burn_rate, status
    | RENAME journey.name AS journey, jhi AS health_index, n AS attempts`,
    [["journey", "string"], ["health_index", "number"], ["attempts", "number"], ["completion_pct", "number"], ["burn_rate", "number", "SLO burn rate"], ["status", "string"]],
    { table: true, colorBy: { health_index: bands([80, 90, 100]) } }),
  varTrend: esql("secbank-d0-var-trend", "Value at risk per minute (USD)", `FROM ${BIZ} | WHERE event.category == "journey" AND ${NOLOAD}
    AND (journey.failure_class == "technical" OR journey.status == "pending")
    | STATS failed = SUM(CASE(journey.status == "failed", bank.txn.amount, 0.0)), pending = SUM(CASE(journey.status == "pending", bank.txn.amount, 0.0))
      BY minute = BUCKET(@timestamp, 1 minute) | SORT minute`,
    [["failed", "number"], ["pending", "number"], ["minute", "date"]], { xy: "area_stacked", x: "minute", y: ["failed", "pending"] },
    { colors: { failed: COL.bad, pending: COL.watch } }),
  channels: esql("secbank-d0-channels", "Transactions by channel", `FROM ${BIZ} | WHERE ${NOLOAD} AND bank.channel IS NOT NULL
    AND ((event.category == "journey" AND ${TERMINAL}) OR event.category == "transaction")
    | STATS transactions = COUNT(*) BY bank.channel | SORT transactions DESC`,
    [["transactions", "number"], ["bank.channel", "string"]], { xy: "bar_horizontal", x: "bank.channel", y: ["transactions"], labels: true }),
  segments: esql("secbank-d0-segments", "Customers impacted by segment (last 15 min)", `FROM ${BIZ} | WHERE ${last(15)} AND event.category == "journey" AND ${NOLOAD} ${IMPACTED}
    | STATS customers = COUNT_DISTINCT(bank.customer.ref) BY bank.customer.segment | SORT customers DESC`,
    [["customers", "number"], ["bank.customer.segment", "string"]], { xy: "bar_horizontal", x: "bank.customer.segment", y: ["customers"], labels: true }),
  slos: esql("secbank-d0-slos", "Journey SLOs burning fastest (1 h burn rate)", `FROM bank-journey-health | WHERE ${last(60)}
    | STATS n = SUM(health.attempts), done = SUM(health.completed), slo = MAX(health.slo_completion_pct) BY journey.name
    | EVAL burn_rate = ROUND((1 - TO_DOUBLE(done) / n) / (1 - slo / 100.0), 1),
      status = CASE(burn_rate >= 14.4, "Violated", burn_rate >= 2, "Degrading", "Healthy"), slo_pct = slo
    | SORT burn_rate DESC | LIMIT 5 | KEEP journey.name, slo_pct, burn_rate, status | RENAME journey.name AS slo`,
    [["slo", "string"], ["slo_pct", "number"], ["burn_rate", "number"], ["status", "string"]],
    { table: true, colorBy: { burn_rate: bands([2, 14.4, 1000], [COL.good, COL.watch, COL.bad], 1000) } }),
  openList: esql("secbank-d0-open", "Open business incidents, by severity then value at risk", `FROM bank-problem-rank | WHERE kind == "problem"
    | SORT slot | KEEP problem.id, problem.severity, problem.title, problem.started_at, problem.detected_at, impact.customers, impact.value_at_risk, problem.owner`,
    [["problem.id", "string", "Problem"], ["problem.severity", "string"], ["problem.title", "string"], ["problem.started_at", "date", "Started"], ["problem.detected_at", "date", "Detected"],
      ["impact.customers", "number"], ["impact.value_at_risk", "number"], ["problem.owner", "string"]], { table: true }),
  heatmap: vega("secbank-d0-heatmap", "Journey health index, every 2 minutes", {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: { index: "bank-journey-health", "%context%": true, "%timefield%": "@timestamp", body: { size: 0, aggs: {
      j: { terms: { field: "journey.name", size: 10 }, aggs: { t: { date_histogram: { field: "@timestamp", fixed_interval: "2m" }, aggs: {
        n: { sum: { field: "health.attempts" } }, done: { sum: { field: "health.completed" } }, tech: { sum: { field: "health.tech_failures" } },
        sat: { sum: { field: "health.satisfied" } }, tol: { sum: { field: "health.tolerating" } }, pv: { sum: { field: "health.page_views" } },
        pvok: { sum: { field: "health.page_views_pass" } }, slo: { max: { field: "health.slo_completion_pct" } } } } } } } } },
      format: { property: "aggregations.j.buckets" } },
    transform: [{ flatten: ["t.buckets"], as: ["b"] },
      { filter: "datum.b.n.value > 0" },
      { calculate: "datum.b.n.value", as: "n" },
      { calculate: "min(1, (datum.b.done.value / datum.n) / (datum.b.slo.value / 100))", as: "c" },
      { calculate: "(datum.b.sat.value + datum.b.tol.value / 2) / datum.n", as: "a" },
      { calculate: "max(0, 1 - (datum.b.tech.value / datum.n) / 0.05)", as: "e" },
      { calculate: "datum.b.pv.value > 0 ? datum.b.pvok.value / datum.b.pv.value : 1", as: "x" },
      { calculate: "round(100 * (0.4 * datum.c + 0.25 * datum.a + 0.2 * datum.e + 0.15 * datum.x))", as: "health" },
      { calculate: "toDate(datum.b.key)", as: "time" }, { calculate: "timeFormat(datum.time, '%H:%M')", as: "hm" }],
    mark: { type: "rect", tooltip: true },
    encoding: {
      x: { field: "hm", type: "ordinal", title: null, sort: { field: "time" }, axis: { labelAngle: 0, labelOverlap: true } },
      y: { field: "key", type: "nominal", title: null, sort: { op: "min", field: "health" } },
      color: { field: "health", type: "quantitative", title: "Health",
        scale: { type: "threshold", domain: [80, 90], range: [COL.bad, COL.watch, COL.good] } },
      tooltip: [{ field: "key", title: "Journey" }, { field: "hm", title: "Time" }, { field: "health", title: "Health index" }],
    },
  }),
  definitions: markdown("secbank-d0-definitions", "Definitions", DEFINITIONS),
}
dashboard(0, "One-screen business health: journeys, impacted customers, value at risk, open problems. Simulated bank data.", [
  [7, [d0.healthy, 8], [d0.impacted, 8], [d0.var, 8], [d0.completion, 8], [d0.cim, 8], [d0.incidents, 8]],
  [14, [d0.scorecard, 22], [d0.varTrend, 26]],
  [14, [d0.heatmap, 48]],
  [11, [d0.channels, 16], [d0.segments, 16], [d0.slos, 16]],
  [10, [d0.openList, 48]],
  [12, [d0.definitions, 48]],
], [["biz", "bank.channel", "Channel"], ["biz", "bank.customer.segment", "Segment"], ["biz", "bank.region", "Region"], ["biz", "journey.name", "Journey"]])

// =====================================================================
// D1 Journeys (journey control pre-set to bill pay, as when arriving from D0)
// =====================================================================
const JEV = `FROM ${BIZ} | WHERE event.category == "journey" AND ${NOLOAD}`
const TECH = 'journey.failure_class == "technical"'
const d1 = {
  health: esql("secbank-d1-health", "Health index", `FROM bank-journey-health ${JHI} | STATS health_index = MIN(jhi)`,
    [["health_index", "number", "Health index (lowest selected)"]], { metric: "health_index", palette: bands([80, 90, 100]) }),
  started: esql("secbank-d1-started", "Started", `${JEV} | STATS started = COUNT_DISTINCT(journey.id)`, [["started", "number", "Journeys started"]], { metric: "started" }),
  completed: d0.completion,
  p95: esql("secbank-d1-p95", "Time to complete", `${JEV} AND journey.status == "completed"
    | STATS p95_s = ROUND(PERCENTILE(journey.duration_ms, 95) / 1000.0, 1), median_s = ROUND(MEDIAN(journey.duration_ms) / 1000.0, 1)
    | EVAL median = CONCAT("median ", TO_STRING(median_s), " s") | KEEP p95_s, median`,
    [["p95_s", "number", "p95 seconds"], ["median", "string"]], { metric: "p95_s", secondary: "median" }),
  flow: esql("secbank-d1-flow", "Started, completed and lost per minute", `${JEV}
    | EVAL s = CASE(journey.step_index == 1, 1, 0), c = CASE(journey.status == "completed", 1, 0),
      l = CASE(journey.status IN ("failed", "abandoned", "pending"), 1, 0)
    | STATS started = SUM(s), completed = SUM(c), lost = SUM(l) BY minute = BUCKET(@timestamp, 1 minute) | SORT minute`,
    [["started", "number"], ["completed", "number"], ["lost", "number"], ["minute", "date"]], { xy: "line", x: "minute", y: ["started", "completed", "lost"] },
    { colors: { started: COL.blue, completed: COL.good, lost: COL.bad } }),
  problems: esql("secbank-d1-problems", "Active problems for this journey", `FROM bank-problems | WHERE problem.status == "open"
    | SORT problem.severity_rank, impact.value_at_risk DESC
    | KEEP problem.id, problem.severity, problem.title, problem.detected_at, impact.customers, impact.value_at_risk, problem.owner`,
    [["problem.id", "string", "Problem"], ["problem.severity", "string"], ["problem.title", "string"], ["problem.detected_at", "date", "Detected"],
      ["impact.customers", "number"], ["impact.value_at_risk", "number"], ["problem.owner", "string"]], { table: true }),
  funnel: esql("secbank-d1-funnel", "Step funnel: where attempts were lost", `${JEV}
    | EVAL step = CONCAT(TO_STRING(journey.step_index), ". ", journey.step), lost_here = CASE(journey.status IN ("failed", "abandoned", "pending"), 1, 0)
    | STATS reached = COUNT_DISTINCT(journey.id), lost = SUM(lost_here) BY step | SORT step`,
    [["reached", "number"], ["lost", "number"], ["step", "string"]], { xy: "bar", x: "step", y: ["reached", "lost"], labels: true },
    { colors: { reached: COL.blue, lost: COL.bad } }),
  reasons: esql("secbank-d1-reasons", "Why attempts fail", `${JEV} AND journey.reason_code IS NOT NULL
    | STATS attempts = COUNT(*) BY journey.reason_code, journey.failure_class | SORT attempts DESC | LIMIT 10`,
    [["attempts", "number"], ["journey.reason_code", "string", "Reason"], ["journey.failure_class", "string", "Class"]],
    { xy: "bar_horizontal", x: "journey.reason_code", y: ["attempts"], split: "journey.failure_class" }),
  parts: esql("secbank-d1-parts", "Why the health index is what it is (C, A, E, X)", `FROM bank-journey-health ${JHI}
    | KEEP journey.name, jhi, c, a, e, x | EVAL c = ROUND(c * 100), a = ROUND(a * 100), e = ROUND(e * 100), x = ROUND(x * 100) | SORT jhi`,
    [["journey.name", "string", "Journey"], ["jhi", "number", "Health index"], ["c", "number", "C completion"], ["a", "number", "A Apdex"],
      ["e", "number", "E errors"], ["x", "number", "X experience"]],
    { table: true, colorBy: Object.fromEntries(["jhi", "c", "a", "e", "x"].map((k) => [k, bands([80, 90, 100])])) }),
  slo: esql("secbank-d1-slo", "Completion SLO: burn rate by window", `FROM bank-journey-health
    | EVAL recent = @timestamp >= ${END} - 5 minutes
    | STATS n1h = SUM(health.attempts), d1h = SUM(health.completed), n5 = SUM(CASE(recent, health.attempts, 0)), d5 = SUM(CASE(recent, health.completed, 0)),
      slo = MAX(health.slo_completion_pct) BY journey.name
    | EVAL completion_pct = ROUND(100.0 * d1h / n1h, 1), burn_window = ROUND((1 - TO_DOUBLE(d1h) / n1h) / (1 - slo / 100.0), 1),
      burn_5m = ROUND((1 - TO_DOUBLE(d5) / n5) / (1 - slo / 100.0), 1) | SORT burn_window DESC
    | KEEP journey.name, slo, completion_pct, burn_window, burn_5m`,
    [["journey.name", "string", "Journey"], ["slo", "number", "SLO %"], ["completion_pct", "number"], ["burn_window", "number", "Burn (time range)"],
      ["burn_5m", "number", "Burn (5 min)"]], { table: true, colorBy: { burn_5m: bands([2, 14.4, 1000], [COL.good, COL.watch, COL.bad], 1000) } }),
  steps: esql("secbank-d1-steps", "Step latency against target", `${JEV} AND journey.step_duration_ms IS NOT NULL
    | STATS p95_ms = ROUND(PERCENTILE(journey.step_duration_ms, 95)), attempts = COUNT(*) BY journey.step_key
    | LOOKUP JOIN bank-journey-steps ON journey.step_key
    | EVAL services = MV_CONCAT(journey.step_services, ", "), over_target = CASE(p95_ms > journey.step_target_ms, "over", "ok")
    | SORT journey.name, journey.step_index | KEEP journey.step_key, journey.step_label, services, journey.step_target_ms, p95_ms, over_target, attempts`,
    [["journey.step_key", "string", "Step"], ["journey.step_label", "string", "Label"], ["services", "string", "Owning services"],
      ["journey.step_target_ms", "number", "Target ms"], ["p95_ms", "number", "p95 ms"], ["over_target", "string", "Status"], ["attempts", "number"]], { table: true }),
  pending: esql("secbank-d1-pending", "Pending payments by age (SLA 15 min)", `${JEV} AND journey.status == "pending"
    | EVAL age_min = DATE_DIFF("minute", @timestamp, ${END}),
      age = CASE(age_min < 5, "0-5 min", age_min < 10, "5-10 min", age_min < 15, "10-15 min", "over 15 min (past SLA)")
    | STATS payments = COUNT(*), value = ROUND(SUM(bank.txn.amount)) BY age | SORT age`,
    [["payments", "number"], ["value", "number"], ["age", "string"]], { xy: "bar", x: "age", y: ["payments"], labels: true }, { colors: { payments: COL.watch } }),
  hist: esql("secbank-d1-hist", "Time to complete, distribution (seconds)", `${JEV} AND journey.status == "completed"
    | EVAL seconds = FLOOR(journey.duration_ms / 2000.0) * 2 | WHERE seconds <= 120 | STATS journeys = COUNT(*) BY seconds | SORT seconds`,
    [["journeys", "number"], ["seconds", "number"]], { xy: "bar", x: "seconds", y: ["journeys"] }),
  cwv: esql("secbank-d1-cwv", "Core Web Vitals per step page", `FROM ${BIZ} | WHERE event.category == "page_view"
    | STATS views = COUNT(*), lcp_p75 = ROUND(PERCENTILE(page.lcp_ms, 75)), inp_p75 = ROUND(PERCENTILE(page.inp_ms, 75)),
      cls_p75 = ROUND(PERCENTILE(page.cls, 75), 3), pass_pct = ROUND(AVG(CASE(page.vitals_pass, 100.0, 0.0)), 1) BY page.route | SORT views DESC`,
    [["page.route", "string", "Page route"], ["views", "number"], ["lcp_p75", "number", "LCP p75 ms"], ["inp_p75", "number", "INP p75 ms"],
      ["cls_p75", "number", "CLS p75"], ["pass_pct", "number", "All vitals pass %"]], { table: true, colorBy: { pass_pct: bands([75, 90, 100]) } }),
  synth: esql("secbank-d1-synth", "Synthetic journey monitors", `FROM logs-bank.synthetics-default | WHERE monitor.type == "browser"
    | STATS runs = COUNT(*), up = SUM(summary.up), last_run = MAX(@timestamp) BY monitor.name, observer.geo.name
    | EVAL availability_pct = ROUND(100.0 * up / runs, 1) | SORT availability_pct, monitor.name | KEEP monitor.name, observer.geo.name, availability_pct, runs, last_run`,
    [["monitor.name", "string", "Monitor"], ["observer.geo.name", "string", "Location"], ["availability_pct", "number"], ["runs", "number"], ["last_run", "date"]],
    { table: true, colorBy: { availability_pct: bands([90, 99, 100.1]) } }),
  byChannel: esql("secbank-d1-by-channel", "Technical failures by channel", `${JEV} AND ${TECH} | STATS failures = COUNT(*) BY bank.channel | SORT failures DESC`,
    [["failures", "number"], ["bank.channel", "string", "Channel"]], { xy: "bar_horizontal", x: "bank.channel", y: ["failures"], labels: true }, { colors: { failures: COL.bad } }),
  bySegment: esql("secbank-d1-by-segment", "Technical failures by segment", `${JEV} AND ${TECH} | STATS failures = COUNT(*) BY bank.customer.segment | SORT failures DESC`,
    [["failures", "number"], ["bank.customer.segment", "string", "Segment"]], { xy: "bar_horizontal", x: "bank.customer.segment", y: ["failures"], labels: true }, { colors: { failures: COL.bad } }),
  byRegion: esql("secbank-d1-by-region", "Technical failures by region", `${JEV} AND ${TECH} | STATS failures = COUNT(*) BY bank.region | SORT failures DESC`,
    [["failures", "number"], ["bank.region", "string", "Region"]], { xy: "bar_horizontal", x: "bank.region", y: ["failures"], labels: true }, { colors: { failures: COL.bad } }),
  customers: esql("secbank-d1-customers", "Impacted customers, highest value first", `${JEV} AND ${TECH}
    | STATS value = ROUND(SUM(bank.txn.amount), 2), failures = COUNT(*), last_failure = MAX(@timestamp)
      BY bank.customer.ref, bank.customer.segment, bank.region, journey.reason_code | SORT value DESC NULLS LAST | LIMIT 25`,
    [["bank.customer.ref", "string", "Customer ref"], ["bank.customer.segment", "string", "Segment"], ["bank.region", "string", "Region"],
      ["journey.reason_code", "string", "Reason"], ["value", "number", "Value USD"], ["failures", "number"], ["last_failure", "date"]], { table: true }),
  cohort: esql("secbank-d1-cohort", "Completion by browser and device", `${JEV} AND ${TERMINAL} AND user_agent.name IS NOT NULL
    | STATS attempts = COUNT(*), done = SUM(CASE(journey.status == "completed", 1, 0)) BY user_agent.name, user_agent.device.name
    | EVAL completion_pct = ROUND(100.0 * done / attempts, 1) | SORT completion_pct | KEEP user_agent.name, user_agent.device.name, completion_pct, attempts`,
    [["user_agent.name", "string", "Browser"], ["user_agent.device.name", "string", "Device"], ["completion_pct", "number"], ["attempts", "number"]],
    { table: true, colorBy: { completion_pct: bands([90, 97, 100.1]) } }),
}
dashboard(1, "One journey end to end: funnel, reasons, health parts, SLO, step latency, pending, vitals, who is hurt.", [
  [7, [d1.health, 8], [d1.started, 8], [d1.completed, 8], [d0.impacted, 8], [d0.var, 8], [d1.p95, 8]],
  [12, [d1.flow, 30], [d1.problems, 18]],
  [12, [d1.funnel, 24], [d1.reasons, 24]],
  [10, [d1.parts, 24], [d1.slo, 24]],
  [12, [d1.steps, 30], [d1.pending, 18]],
  [11, [d1.hist, 20], [d1.cwv, 28]],
  [10, [d1.synth, 48]],
  [10, [d1.byChannel, 16], [d1.bySegment, 16], [d1.byRegion, 16]],
  [12, [d1.customers, 30], [d1.cohort, 18]],
  [10, [d0.definitions, 48]],
], [["biz", "journey.name", "Journey", ["bill_pay"]], ["biz", "bank.channel", "Channel"], ["biz", "bank.customer.segment", "Segment"], ["biz", "bank.region", "Region"]])

// =====================================================================
// D2 Branches
// =====================================================================
const INPERSON = 'bank.channel IN ("branch", "atm")'
const DIGITAL = 'bank.channel IN ("web", "mobile_web", "partner_api")'
const d2 = {
  online: esql("secbank-d2-online", "Branches online", `FROM ${BIZ} | WHERE ${last(5)} AND ${INPERSON} | STATS online = COUNT_DISTINCT(bank.branch.id)`,
    [["online", "number", "Branches transacting, last 5 min"]], { metric: "online" }),
  teller: esql("secbank-d2-teller", "Teller transactions", `FROM ${BIZ} | WHERE bank.channel == "branch" AND (event.category == "transaction" OR ${TERMINAL})
    | STATS transactions = COUNT(*)`, [["transactions", "number"]], { metric: "transactions" }),
  atm: esql("secbank-d2-atm", "ATM transactions", `FROM ${BIZ} | WHERE bank.channel == "atm" AND (event.category == "transaction" OR ${TERMINAL})
    | STATS transactions = COUNT(*)`, [["transactions", "number"]], { metric: "transactions" }),
  atms: esql("secbank-d2-atms", "ATMs online", `FROM ${BIZ} | WHERE ${last(10)} AND event.category == "heartbeat" | STATS atms = COUNT_DISTINCT(bank.atm.id)`,
    [["atms", "number", "ATMs with a heartbeat, last 10 min"]], { metric: "atms" }),
  health: esql("secbank-d2-health", "In-person journey completion", `FROM ${BIZ} | WHERE ${INPERSON} AND event.category == "journey" AND ${TERMINAL}
    | STATS attempts = COUNT(*), done = SUM(CASE(journey.status == "completed", 1, 0)) | EVAL completion_pct = ROUND(100.0 * done / attempts, 1) | KEEP completion_pct`,
    [["completion_pct", "number", "Completion % (branch and ATM)"]], { metric: "completion_pct", palette: bands([95, 98, 100.1]) }),
  // Over the digital payment journeys (bill pay, transfers, card payments), where value moves.
  regions: esql("secbank-d2-regions-hit", "Regions with impacted digital customers", `FROM ${BIZ} | WHERE ${DIGITAL} AND event.category == "journey" AND ${TERMINAL}
    AND journey.name IN ("bill_pay", "p2p_transfer", "card_payment")
    | STATS n = COUNT(*), tech = SUM(CASE(${TECH}, 1, 0)) BY bank.region | WHERE TO_DOUBLE(tech) / n > 0.02
    | STATS regions = COUNT(*), names = MV_CONCAT(VALUES(bank.region), ", ")`,
    [["regions", "number", "Regions over 2 % digital payment failures"], ["names", "string"]], { metric: "regions", secondary: "names" }),
  problems: esql("secbank-d2-problems", "Branch and ATM problems", `FROM bank-problems | WHERE problem.status == "open" AND problem.kind == "branch_dark"
    | KEEP problem.id, problem.title, bank.region, problem.started_at, impact.value_delayed, problem.owner`,
    [["problem.id", "string", "Problem"], ["problem.title", "string"], ["bank.region", "string", "Region"], ["problem.started_at", "date", "Started"],
      ["impact.value_delayed", "number", "Value delayed"], ["problem.owner", "string"]], { table: true }),
  table: esql("secbank-d2-regions", "Regions: in-person activity and digital bill pay failures", `FROM ${BIZ} | WHERE (event.category == "journey" AND ${TERMINAL}) OR event.category == "transaction"
    | EVAL inp = CASE(${INPERSON}, 1, 0), bill = CASE(journey.name == "bill_pay" AND ${DIGITAL}, 1, 0), bill_tech = CASE(journey.name == "bill_pay" AND ${DIGITAL} AND ${TECH}, 1, 0)
    | STATS in_person = SUM(inp), branches = COUNT_DISTINCT(bank.branch.id), digital_bill_pay = SUM(bill), bill_tech = SUM(bill_tech) BY bank.region
    | EVAL bill_pay_failure_pct = ROUND(100.0 * bill_tech / digital_bill_pay, 1) | SORT bill_pay_failure_pct DESC
    | KEEP bank.region, branches, in_person, digital_bill_pay, bill_pay_failure_pct`,
    [["bank.region", "string", "Region"], ["branches", "number", "Branches active"], ["in_person", "number", "In-person transactions"],
      ["digital_bill_pay", "number", "Digital bill pays"], ["bill_pay_failure_pct", "number", "Bill pay technical failure %"]],
    { table: true, colorBy: { bill_pay_failure_pct: bands([2, 5, 1000], [COL.good, COL.watch, COL.bad], 1000) } }),
  atmChecks: esql("secbank-d2-atm-checks", "ATM synthetic checks", `FROM logs-bank.synthetics-default | WHERE monitor.id LIKE "atm-*"
    | STATS runs = COUNT(*), up = SUM(summary.up), down = SUM(summary.down), last_run = MAX(@timestamp) BY monitor.name
    | EVAL availability_pct = ROUND(100.0 * up / runs, 1) | SORT availability_pct | KEEP monitor.name, availability_pct, down, runs, last_run`,
    [["monitor.name", "string", "Monitor"], ["availability_pct", "number"], ["down", "number", "Failed runs"], ["runs", "number"], ["last_run", "date"]],
    { table: true, colorBy: { availability_pct: bands([90, 99, 100.1]) } }),
  bubble: vega("secbank-d2-bubble", "Branch volume against failure rate", {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: { index: "logs-bank.business-*", "%context%": true, "%timefield%": "@timestamp", body: { size: 0,
      // %context% owns the query, so the channel filter is a filter aggregation.
      aggs: { inp: { filter: { terms: { "bank.channel": ["branch", "atm"] } }, aggs: {
        b: { terms: { field: "bank.branch.id", size: 50 }, aggs: { r: { terms: { field: "bank.region", size: 1 } },
          fail: { filter: { terms: { "journey.status": ["failed", "pending"] } } } } } } } } } },
      format: { property: "aggregations.inp.b.buckets" } },
    transform: [{ calculate: "datum.key", as: "branch" }, { calculate: "datum.doc_count", as: "volume" },
      { calculate: "100 * datum.fail.doc_count / datum.doc_count", as: "failure_pct" },
      { calculate: "datum.r.buckets.length ? datum.r.buckets[0].key : 'n/a'", as: "region" }],
    mark: { type: "circle", opacity: 0.75, tooltip: true },
    encoding: { x: { field: "volume", type: "quantitative", title: "Transactions" }, y: { field: "failure_pct", type: "quantitative", title: "Failed %" },
      size: { field: "volume", type: "quantitative", legend: null }, color: { field: "region", type: "nominal", title: "Region" },
      tooltip: [{ field: "branch" }, { field: "region" }, { field: "volume" }, { field: "failure_pct", format: ".1f" }] },
  }),
  map: add({
    id: "secbank-d2-map", type: "map", ...MIG, typeMigrationVersion: "8.4.0",
    attributes: { title: "Branches by region", description: "Branches with teller or ATM activity in the time range, coloured by region. A dark branch drops off the map.",
      mapStateJSON: JSON.stringify({ zoom: 3.3, center: { lon: -96, lat: 38.5 }, timeFilters: { from: "now-60m", to: "now" },
        refreshConfig: { isPaused: true, interval: 0 }, query: { query: "", language: "kuery" }, filters: [], settings: { autoFitToDataBounds: false } }),
      layerListJSON: JSON.stringify([
        { id: "basemap", type: "EMS_VECTOR_TILE", sourceDescriptor: { type: "EMS_TMS", isAutoSelect: true, lightModeDefault: "road_map_desaturated" },
          visible: true, alpha: 1, minZoom: 0, maxZoom: 24, includeInFitToBounds: true, style: { type: "EMS_VECTOR_TILE" } },
        // One point per branch (latest event), coloured by region.
        { id: "branches", type: "GEOJSON_VECTOR", label: "Branches", visible: true, alpha: 0.9, minZoom: 0, maxZoom: 24, includeInFitToBounds: true,
          joins: [], query: { query: 'bank.channel : ("branch" or "atm")', language: "kuery" },
          sourceDescriptor: { type: "ES_SEARCH", id: "branches-src", geoField: "bank.branch.location", scalingType: "TOP_HITS",
            topHitsSplitField: "bank.branch.id", topHitsSize: 1, sortField: "@timestamp", sortOrder: "desc", filterByMapBounds: false,
            tooltipProperties: ["bank.branch.id", "bank.region"], applyGlobalQuery: true, applyGlobalTime: true,
            indexPatternRefName: "layer_0_source_index_pattern" },
          style: { type: "VECTOR", isTimeAware: true, properties: {
            fillColor: { type: "DYNAMIC", options: { type: "CATEGORICAL", field: { name: "bank.region", origin: "source" }, colorCategory: "palette_0", useCustomColorPalette: false } },
            lineColor: { type: "STATIC", options: { color: "#FFFFFF" } }, lineWidth: { type: "STATIC", options: { size: 1 } },
            iconSize: { type: "STATIC", options: { size: 9 } }, symbolizeAs: { options: { value: "circle" } }, icon: { type: "STATIC", options: { value: "marker" } } } } },
      ]),
      uiStateJSON: JSON.stringify({ isLayerTOCOpen: false, openTOCDetails: [] }) },
    references: [{ name: "layer_0_source_index_pattern", type: "index-pattern", id: DV.biz.id }],
  }),
}
dashboard(2, "The enterprise view: branches, ATMs and regions next to digital failures.", [
  [7, [d2.online, 8], [d2.teller, 8], [d2.atm, 8], [d2.atms, 8], [d2.health, 8], [d2.regions, 8]],
  [16, [d2.map, 30], [d2.problems, 18]],
  [11, [d2.table, 30], [d2.atmChecks, 18]],
  [13, [d2.bubble, 48]],
], [["biz", "bank.region", "Region"], ["biz", "bank.branch.id", "Branch"], ["biz", "bank.channel", "Channel"]])

// =====================================================================
// D3 Customer Lens (pick a customer ref; arriving from D1's impacted-customers table)
// =====================================================================
const d3 = {
  customer: esql("secbank-d3-customer", "Customer", `FROM bank-customers | KEEP bank.customer.ref, bank.customer.segment, bank.region, bank.branch.id, labels.data_source | LIMIT 5`,
    [["bank.customer.ref", "string", "Ref"], ["bank.customer.segment", "string", "Segment"], ["bank.region", "string", "Region"],
      ["bank.branch.id", "string", "Home branch"], ["labels.data_source", "string", "Source"]], { table: true }, { time: false }),
  journeys: esql("secbank-d3-journeys", "Journeys", `${JEV} | STATS journeys = COUNT_DISTINCT(journey.id)`, [["journeys", "number", "Journeys in range"]], { metric: "journeys" }),
  failed: esql("secbank-d3-failed", "Failed now", `${JEV} AND ${last(60)} AND ${TECH} | STATS failures = COUNT(*)`,
    [["failures", "number", "Technical failures, last 60 min"]], { metric: "failures", color: COL.bad }),
  unpaid: esql("secbank-d3-unpaid", "Value not paid", `${JEV} AND ${TECH} AND journey.status IN ("failed", "pending") | STATS value = ROUND(SUM(bank.txn.amount), 2)`,
    [["value", "number", "USD failed or pending"]], { metric: "value" }),
  device: esql("secbank-d3-device", "Device, last session", `FROM ${BIZ} | WHERE event.category == "page_view" | SORT @timestamp DESC | LIMIT 1
    | KEEP user_agent.name, user_agent.device.name, bank.channel, service.version`,
    [["user_agent.name", "string", "Browser"], ["user_agent.device.name", "string", "Device"], ["bank.channel", "string", "Channel"], ["service.version", "string", "web-ui"]], { table: true }),
  experience: esql("secbank-d3-experience", "Experience", `FROM ${BIZ} | WHERE event.category == "page_view"
    | STATS views = COUNT(*), lcp_p75 = ROUND(PERCENTILE(page.lcp_ms, 75)), inp_p75 = ROUND(PERCENTILE(page.inp_ms, 75)), pass_pct = ROUND(AVG(CASE(page.vitals_pass, 100.0, 0.0)), 1)`,
    [["views", "number", "Page views"], ["lcp_p75", "number", "LCP p75 ms"], ["inp_p75", "number", "INP p75 ms"], ["pass_pct", "number", "Vitals pass %"]], { table: true }),
  trail: esql("secbank-d3-trail", "Journey trail", `${JEV} | SORT @timestamp DESC | LIMIT 100
    | KEEP @timestamp, journey.name, journey.step, journey.status, journey.reason_code, journey.step_duration_ms, bank.txn.amount, bank.channel, trace.id, journey.id`,
    [["@timestamp", "date", "Time"], ["journey.name", "string", "Journey"], ["journey.step", "string", "Step"], ["journey.status", "string", "Status"],
      ["journey.reason_code", "string", "Reason"], ["journey.step_duration_ms", "number", "Step ms"], ["bank.txn.amount", "number", "Amount"],
      ["bank.channel", "string", "Channel"], ["trace.id", "string", "Trace"], ["journey.id", "string", "Journey id"]], { table: true }),
  failures: search("secbank-d3-failures", "Failed steps for this customer (Discover)", "biz",
    ["journey.name", "journey.step", "journey.reason_code", "bank.dependency", "service.name", "trace.id"], 'journey.failure_class : "technical"'),
  piiLogs: esql("secbank-d3-pii-logs", "Zero raw PII: email addresses in logs", `FROM logs-bank.app-default
    | WHERE message LIKE "*@*.*" | STATS emails = COUNT(*)`,
    [["emails", "number", "Log lines with an email address"]], { metric: "emails", color: COL.good }),
  piiRefs: esql("secbank-d3-pii-refs", "Zero raw PII: customer identifiers", `FROM ${BIZ} | WHERE bank.customer.ref IS NOT NULL
    | EVAL raw = CASE(bank.customer.ref RLIKE "C-[0-9A-F]{6}", 0, 1) | STATS non_pseudonymous = SUM(raw), checked = COUNT(*)
    | EVAL detail = CONCAT("of ", TO_STRING(checked), " events checked") | KEEP non_pseudonymous, detail`,
    [["non_pseudonymous", "number", "Customer ids that are not a C-XXXXXX ref"], ["detail", "string"]], { metric: "non_pseudonymous", secondary: "detail", color: COL.good }),
}
dashboard(3, "One customer, pseudonymous ref only: their journeys, failures, device and experience. No name, email or balance anywhere.", [
  [7, [d3.customer, 16], [d3.journeys, 8], [d3.failed, 8], [d3.unpaid, 8], [d3.piiLogs, 8]],
  [7, [d3.device, 16], [d3.experience, 22], [d3.piiRefs, 10]],
  [16, [d3.trail, 48]],
  [12, [d3.failures, 48]],
], [["biz", "bank.customer.ref", "Customer ref"], ["biz", "journey.name", "Journey"], ["biz", "event.outcome", "Outcome"]], "now-24h")

// =====================================================================
// D4 Experience (page views carry Core Web Vitals; the simulated web-ui is mobile web and desktop web only)
// =====================================================================
const PV = `FROM ${BIZ} | WHERE event.category == "page_view"`
const d4 = {
  views: esql("secbank-d4-views", "Page views", `${PV} | STATS views = COUNT(*)`, [["views", "number", "Page views"]], { metric: "views" }),
  pass: esql("secbank-d4-pass", "Core Web Vitals pass", `${PV} | STATS pass_pct = ROUND(AVG(CASE(page.vitals_pass, 100.0, 0.0)), 1)`,
    [["pass_pct", "number", "Views passing LCP, INP and CLS %"]], { metric: "pass_pct", palette: bands([75, 90, 100.1]) }),
  lcp: esql("secbank-d4-lcp", "LCP p75", `${PV} | STATS lcp_ms = ROUND(PERCENTILE(page.lcp_ms, 75))`, [["lcp_ms", "number", "LCP p75 ms (good under 2500)"]], { metric: "lcp_ms" }),
  inp: esql("secbank-d4-inp", "INP p75", `${PV} | STATS inp_ms = ROUND(PERCENTILE(page.inp_ms, 75))`, [["inp_ms", "number", "INP p75 ms (good under 200)"]], { metric: "inp_ms" }),
  cls: esql("secbank-d4-cls", "CLS p75", `${PV} | STATS cls = ROUND(PERCENTILE(page.cls, 75), 3)`, [["cls", "number", "CLS p75 (good under 0.1)"]], { metric: "cls" }),
  synthAvail: esql("secbank-d4-synth-avail", "Synthetic availability", `FROM logs-bank.synthetics-default
    | STATS runs = COUNT(*), up = SUM(summary.up) | EVAL availability_pct = ROUND(100.0 * up / runs, 1), detail = CONCAT(TO_STRING(up), " of ", TO_STRING(runs), " runs passed")
    | KEEP availability_pct, detail`, [["availability_pct", "number", "Availability %"], ["detail", "string"]], { metric: "availability_pct", secondary: "detail" }),
  trend: esql("secbank-d4-trend", "Page experience against backend, per minute", `FROM ${BIZ} | WHERE event.category IN ("page_view", "journey")
    | EVAL lcp = CASE(event.category == "page_view", page.lcp_ms), backend = CASE(event.category == "journey", journey.step_duration_ms)
    | STATS lcp_p75 = PERCENTILE(lcp, 75), backend_p95 = PERCENTILE(backend, 95) BY minute = BUCKET(@timestamp, 1 minute) | SORT minute`,
    [["lcp_p75", "number", "LCP p75 ms (RUM)"], ["backend_p95", "number", "Backend step p95 ms"], ["minute", "date"]], { xy: "line", x: "minute", y: ["lcp_p75", "backend_p95"] },
    { colors: { lcp_p75: COL.purple, backend_p95: COL.blue } }),
  releases: esql("secbank-d4-releases", "Releases", `FROM logs-bank.app-default | WHERE event.category == "deployment" | SORT @timestamp DESC
    | KEEP @timestamp, service.name, service.version`, [["@timestamp", "date", "Deployed"], ["service.name", "string", "Service"], ["service.version", "string", "Version"]], { table: true }),
  gap: esql("secbank-d4-gap", "Experience against backend gap, by page", `FROM ${BIZ} | WHERE event.category IN ("page_view", "journey")
    | EVAL lcp = CASE(event.category == "page_view", page.lcp_ms), backend = CASE(event.category == "journey", journey.step_duration_ms)
    | STATS lcp_p75 = ROUND(PERCENTILE(lcp, 75)), backend_p95 = ROUND(PERCENTILE(backend, 95)), views = SUM(CASE(event.category == "page_view", 1, 0)) BY journey.step_key
    | WHERE views > 0 | EVAL gap_ms = lcp_p75 - backend_p95 | SORT gap_ms DESC | KEEP journey.step_key, lcp_p75, backend_p95, gap_ms, views`,
    [["journey.step_key", "string", "Page (journey:step)"], ["lcp_p75", "number", "Front end LCP p75 ms"], ["backend_p95", "number", "Backend p95 ms"],
      ["gap_ms", "number", "Gap ms"], ["views", "number"]], { table: true }),
  devices: esql("secbank-d4-devices", "Vitals by device and browser", `${PV}
    | STATS views = COUNT(*), lcp_p75 = ROUND(PERCENTILE(page.lcp_ms, 75)), inp_p75 = ROUND(PERCENTILE(page.inp_ms, 75)),
      pass_pct = ROUND(AVG(CASE(page.vitals_pass, 100.0, 0.0)), 1) BY user_agent.device.name, user_agent.name | SORT pass_pct`,
    [["user_agent.device.name", "string", "Device"], ["user_agent.name", "string", "Browser"], ["views", "number"], ["lcp_p75", "number", "LCP p75 ms"],
      ["inp_p75", "number", "INP p75 ms"], ["pass_pct", "number", "Pass %"]], { table: true, colorBy: { pass_pct: bands([75, 90, 100.1]) } }),
  vsReal: esql("secbank-d4-vs-real", "Synthetic monitors against real-user completion", `FROM logs-bank.synthetics-default, ${BIZ}
    | WHERE monitor.type == "browser" OR (event.category == "journey" AND ${TERMINAL})
    | EVAL synth = CASE(monitor.type == "browser", 1, 0), synth_up = CASE(monitor.type == "browser", summary.up, 0),
      real = CASE(event.category == "journey", 1, 0), real_done = CASE(journey.status == "completed", 1, 0)
    | STATS runs = SUM(synth), up = SUM(synth_up), attempts = SUM(real), done = SUM(real_done) BY journey.name | WHERE runs > 0
    | EVAL synthetic_pct = ROUND(100.0 * up / runs, 1), real_user_pct = ROUND(100.0 * done / attempts, 1) | SORT synthetic_pct
    | KEEP journey.name, synthetic_pct, real_user_pct, runs, attempts`,
    [["journey.name", "string", "Journey"], ["synthetic_pct", "number", "Synthetic pass %"], ["real_user_pct", "number", "Real-user completion %"],
      ["runs", "number", "Synthetic runs"], ["attempts", "number", "Real attempts"]],
    { table: true, colorBy: { synthetic_pct: bands([90, 99, 100.1]), real_user_pct: bands([90, 97, 100.1]) } }),
  partner: esql("secbank-d4-partner", "Partner API: the digital agent user", `${JEV} AND bank.channel == "partner_api" AND ${TERMINAL}
    | STATS attempts = COUNT(*), done = SUM(CASE(journey.status == "completed", 1, 0)), p95_ms = ROUND(PERCENTILE(journey.duration_ms, 95)) BY journey.name
    | EVAL completion_pct = ROUND(100.0 * done / attempts, 1) | SORT attempts DESC | KEEP journey.name, attempts, completion_pct, p95_ms`,
    [["journey.name", "string", "Journey"], ["attempts", "number"], ["completion_pct", "number"], ["p95_ms", "number", "p95 ms"]], { table: true }),
  jsErrors: esql("secbank-d4-js-errors", "JS errors", `FROM ${BIZ} | WHERE event.category IN ("page_view", "js_error")
    | STATS errors = SUM(CASE(event.category == "js_error", 1, 0)), views = SUM(CASE(event.category == "page_view", 1, 0))
    | EVAL per_1000 = ROUND(1000.0 * errors / views, 1), detail = CONCAT(TO_STRING(errors), " errors") | KEEP per_1000, detail`,
    [["per_1000", "number", "JS errors per 1,000 page views"], ["detail", "string"]], { metric: "per_1000", secondary: "detail" }),
  jsByRelease: esql("secbank-d4-js-release", "JS errors by release", `FROM ${BIZ} | WHERE event.category == "js_error"
    | STATS errors = COUNT(*) BY service.version, error.type | SORT service.version`,
    [["errors", "number"], ["service.version", "string", "web-ui release"], ["error.type", "string", "Error"]],
    { xy: "bar_stacked", x: "service.version", y: ["errors"], split: "error.type" }),
  scope: markdown("secbank-d4-scope", "Scope", "Mobile web and desktop web only: no native app, and no session replay (Elastic does not offer it). Simulated page views carry LCP, INP and CLS on `page.*` and JS errors as `event.category : js_error`; the real React app reports through the Elastic RUM agent (service `tensai-secbank-web`) in the User Experience app."),
}
dashboard(4, "Digital experience: Core Web Vitals by page, device and release; synthetic checks against real users; the partner API.", [
  [7, [d4.views, 7], [d4.pass, 7], [d4.lcp, 7], [d4.inp, 7], [d4.cls, 6], [d4.jsErrors, 7], [d4.synthAvail, 7]],
  [13, [d4.trend, 24], [d4.jsByRelease, 12], [d4.releases, 12]],
  [12, [d4.gap, 26], [d4.devices, 22]],
  [11, [d4.vsReal, 26], [d4.partner, 22]],
  [5, [d4.scope, 48]],
], [["biz", "page.route", "Page"], ["biz", "user_agent.device.name", "Device"], ["biz", "user_agent.name", "Browser"], ["biz", "service.version", "Release"]])

// =====================================================================
// D5 Services (APM: simulated microservices + the PHP agent; counts use representative_count, so 10 % sampling is extrapolated)
// =====================================================================
const TX = 'FROM traces-apm* | WHERE processor.event == "transaction"'
const DEP = 'FROM traces-apm* | WHERE processor.event == "span" AND span.destination.service.resource IN ("payment_gw", "sms_otp", "card_processor")'
const d5 = {
  inSlo: esql("secbank-d5-in-slo", "Services and dependencies in SLO", `FROM traces-apm*
    | WHERE processor.event == "transaction" OR (processor.event == "span" AND span.destination.service.resource IN ("payment_gw", "sms_otp", "card_processor"))
    | EVAL entity = CASE(processor.event == "span", span.destination.service.resource, service.name),
      us = CASE(processor.event == "span", span.duration.us, transaction.duration.us), bad = CASE(event.outcome == "failure", 1, 0)
    | STATS p95_ms = PERCENTILE(us, 95) / 1000, fail_pct = 100.0 * AVG(bad) BY entity
    | EVAL ok = CASE(p95_ms <= 3000 AND fail_pct <= 2, 1, 0) | STATS in_slo = SUM(ok), total = COUNT(*), breaching = MV_CONCAT(VALUES(CASE(ok == 0, entity)), ", ")
    | EVAL of = CONCAT("of ", TO_STRING(total), " (p95 <= 3 s, errors <= 2 %); breaching: ", COALESCE(breaching, "none")) | KEEP in_slo, of`,
    [["in_slo", "number", "In SLO"], ["of", "string"]], { metric: "in_slo", secondary: "of" }),
  payErr: esql("secbank-d5-pay-err", "payments-svc error rate", `${TX} AND service.name == "payments-svc"
    | STATS n = SUM(transaction.representative_count), f = SUM(CASE(event.outcome == "failure", transaction.representative_count, 0.0))
    | EVAL error_pct = ROUND(100.0 * f / n, 1), detail = CONCAT(TO_STRING(ROUND(f)), " of ", TO_STRING(ROUND(n)), " requests") | KEEP error_pct, detail`,
    [["error_pct", "number", "Errors %"], ["detail", "string"]], { metric: "error_pct", secondary: "detail" }),
  payLat: esql("secbank-d5-pay-lat", "payments-svc latency", `${TX} AND service.name == "payments-svc"
    | STATS p95_s = ROUND(PERCENTILE(transaction.duration.us, 95) / 1e6, 1), p50_s = ROUND(MEDIAN(transaction.duration.us) / 1e6, 1)
    | EVAL detail = CONCAT("median ", TO_STRING(p50_s), " s") | KEEP p95_s, detail`, [["p95_s", "number", "p95 seconds"], ["detail", "string"]], { metric: "p95_s", secondary: "detail" }),
  gwLat: esql("secbank-d5-gw-lat", "payment_gw latency", `${DEP} AND span.destination.service.resource == "payment_gw"
    | STATS p95_s = ROUND(PERCENTILE(span.duration.us, 95) / 1e6, 1), calls = SUM(span.representative_count),
      timeouts = SUM(CASE(event.outcome == "failure", span.representative_count, 0.0))
    | EVAL detail = CONCAT(TO_STRING(ROUND(timeouts)), " of ", TO_STRING(ROUND(calls)), " calls timed out") | KEEP p95_s, detail`,
    [["p95_s", "number", "p95 seconds"], ["detail", "string"]], { metric: "p95_s", secondary: "detail" }),
  thirdParty: esql("secbank-d5-third-party", "Third-party failure share", `${JEV} AND ${TECH}
    | STATS tech = COUNT(*), dep = SUM(CASE(bank.dependency IS NOT NULL, 1, 0)) | EVAL share_pct = ROUND(100.0 * dep / tech, 1)
    | EVAL detail = CONCAT(TO_STRING(dep), " of ", TO_STRING(tech), " technical failures") | KEEP share_pct, detail`,
    [["share_pct", "number", "Attributed to a dependency %"], ["detail", "string"]], { metric: "share_pct", secondary: "detail" }),
  attribution: esql("secbank-d5-attribution", "Attribution coverage", `${JEV} AND journey.status IN ("failed", "pending") AND ${TECH}
    | STATS failed = COUNT(*), attributed = SUM(CASE(trace.id IS NOT NULL AND service.name IS NOT NULL, 1, 0))
    | EVAL coverage_pct = ROUND(100.0 * attributed / failed, 1), detail = CONCAT(TO_STRING(attributed), " of ", TO_STRING(failed), " with trace and service")
    | KEEP coverage_pct, detail`, [["coverage_pct", "number", "Coverage %"], ["detail", "string"]], { metric: "coverage_pct", secondary: "detail" }),
  latency: esql("secbank-d5-latency", "Latency per minute (p95, seconds)", `${TX} AND labels.data_source == "simulator"
    | STATS p95_s = PERCENTILE(transaction.duration.us, 95) / 1e6 BY minute = BUCKET(@timestamp, 1 minute), service.name | SORT minute`,
    [["p95_s", "number", "p95 s"], ["minute", "date"], ["service.name", "string", "Service"]], { xy: "line", x: "minute", y: ["p95_s"], split: "service.name" }),
  problems: d1.problems,
  services: esql("secbank-d5-services", "Services: rate, errors, duration", `${TX}
    | STATS requests = ROUND(SUM(transaction.representative_count)), f = SUM(CASE(event.outcome == "failure", transaction.representative_count, 0.0)),
      p95_ms = ROUND(PERCENTILE(transaction.duration.us, 95) / 1000), version = MAX(service.version) BY service.name
    | EVAL error_pct = ROUND(100.0 * f / requests, 2) | SORT error_pct DESC | KEEP service.name, version, requests, error_pct, p95_ms`,
    [["service.name", "string", "Service"], ["version", "string", "Version"], ["requests", "number"], ["error_pct", "number", "Errors %"], ["p95_ms", "number", "p95 ms"]],
    { table: true, colorBy: { error_pct: bands([1, 5, 100], [COL.good, COL.watch, COL.bad], 100) } }),
  deps: esql("secbank-d5-deps", "External dependencies", `${DEP}
    | STATS calls = ROUND(SUM(span.representative_count)), f = SUM(CASE(event.outcome == "failure", span.representative_count, 0.0)),
      p95_ms = ROUND(PERCENTILE(span.duration.us, 95) / 1000), callers = MV_CONCAT(VALUES(service.name), ", ") BY span.destination.service.resource
    | EVAL failure_pct = ROUND(100.0 * f / calls, 1) | SORT p95_ms DESC | KEEP span.destination.service.resource, callers, calls, failure_pct, p95_ms`,
    [["span.destination.service.resource", "string", "Dependency"], ["callers", "string", "Called by"], ["calls", "number"], ["failure_pct", "number", "Failures %"],
      ["p95_ms", "number", "p95 ms"]], { table: true, colorBy: { p95_ms: bands([1000, 3000, 1e9], [COL.good, COL.watch, COL.bad], 1e9) } }),
  slowest: search("secbank-d5-slowest", "Slowest failing traces (open one for the waterfall)", "apm",
    ["service.name", "transaction.name", "transaction.duration.us", "transaction.result", "trace.id"],
    'processor.event : "transaction" and event.outcome : "failure"', "transaction.duration.us"),
  map: markdown("secbank-d5-map", "Service map and correlations", "Service map, latency correlations and anomaly swimlanes live in APM, scoped to the same time range:\n\n" +
    "- [Service map](/app/apm/service-map?environment=production)\n- [payments-svc: overview](/app/apm/services/payments-svc/overview?environment=production)\n" +
    "- [payments-svc: failed transaction correlations](/app/apm/services/payments-svc/transactions?environment=production)\n" +
    "- [Dependencies: payment_gw](/app/apm/dependencies/overview?dependencyName=payment_gw&environment=production)\n\n" +
    "Edges come from simulated traces (api-gateway -> services -> payment_gw, sms_otp, card_processor, postgresql)."),
}
dashboard(5, "Services and third-party dependencies behind the journeys: what moved, where, and who to call.", [
  [7, [d5.inSlo, 8], [d5.payErr, 8], [d5.payLat, 8], [d5.gwLat, 8], [d5.thirdParty, 8], [d5.attribution, 8]],
  [13, [d5.latency, 32], [d5.map, 16]],
  [11, [d5.services, 26], [d5.deps, 22]],
  [10, [d5.problems, 48]],
  [12, [d5.slowest, 48]],
], [["apm", "service.name", "Service"], ["apm", "service.version", "Version"], ["biz", "bank.dependency", "Dependency"]])

// =====================================================================
// D6 Platform (simulated Kubernetes, JVM pools, queues, PostgreSQL)
// =====================================================================
const PF = "FROM metrics-bank.platform-default"
const d6 = {
  nodes: esql("secbank-d6-nodes", "Nodes ready", `${PF} | WHERE metricset.name == "node" AND ${last(2)} AND kubernetes.node.ready == true
    | STATS ready = COUNT_DISTINCT(kubernetes.node.name)`, [["ready", "number", "Nodes ready"]], { metric: "ready" }),
  pods: esql("secbank-d6-pods", "Pods running", `${PF} | WHERE metricset.name == "pod" AND ${last(2)} AND kubernetes.pod.phase == "Running"
    | STATS running = COUNT_DISTINCT(kubernetes.pod.name), restarts = MAX(kubernetes.pod.restarts)
    | EVAL detail = CONCAT(TO_STRING(restarts), " restarts") | KEEP running, detail`, [["running", "number", "Pods running"], ["detail", "string"]], { metric: "running", secondary: "detail" }),
  cpu: esql("secbank-d6-cpu", "Cluster CPU", `${PF} | WHERE metricset.name == "node" AND ${last(5)} | STATS cpu_pct = ROUND(100 * AVG(kubernetes.node.cpu.pct), 1)`,
    [["cpu_pct", "number", "CPU %"]], { metric: "cpu_pct", palette: bands([70, 85, 100], [COL.good, COL.watch, COL.bad]) }),
  pool: esql("secbank-d6-pool", "payments-svc gateway connections", `${PF} | WHERE service.name == "payments-svc" AND jvm.http_pool.used IS NOT NULL AND ${last(2)}
    | STATS used = MAX(jvm.http_pool.used), max = MAX(jvm.http_pool.max) | EVAL detail = CONCAT("of ", TO_STRING(max), " in use") | KEEP used, detail`,
    [["used", "number", "Connections in use"], ["detail", "string"]], { metric: "used", secondary: "detail" }),
  queue: esql("secbank-d6-queue", "Retry queue depth", `${PF} | WHERE metricset.name == "queue" AND ${last(2)} | STATS depth = MAX(queue.depth)`,
    [["depth", "number", "Payment retries waiting"]], { metric: "depth" }),
  pg: esql("secbank-d6-pg", "PostgreSQL", `${PF} | WHERE metricset.name == "postgresql" AND ${last(2)}
    | STATS connections = MAX(postgresql.connections), lock_waits = MAX(postgresql.lock_waits), slow = MAX(postgresql.slow_queries)
    | EVAL detail = CONCAT(TO_STRING(lock_waits), " lock waits, ", TO_STRING(slow), " slow queries") | KEEP connections, detail`,
    [["connections", "number", "Connections"], ["detail", "string"]], { metric: "connections", secondary: "detail" }),
  saturation: esql("secbank-d6-saturation", "Saturation over time (%)", `${PF} | WHERE metricset.name IN ("node", "pod")
    | EVAL node = CASE(metricset.name == "node", kubernetes.node.cpu.pct * 100), pay = CASE(service.name == "payments-svc", kubernetes.pod.cpu.pct * 100),
      pool = CASE(jvm.http_pool.used IS NOT NULL, 100.0 * jvm.http_pool.used / jvm.http_pool.max)
    | STATS cluster_cpu = AVG(node), payments_pod_cpu = AVG(pay), gateway_pool = MAX(pool) BY minute = BUCKET(@timestamp, 1 minute) | SORT minute`,
    [["cluster_cpu", "number", "Cluster CPU"], ["payments_pod_cpu", "number", "payments-svc pod CPU"], ["gateway_pool", "number", "Gateway pool, payments-svc"], ["minute", "date"]],
    { xy: "line", x: "minute", y: ["cluster_cpu", "payments_pod_cpu", "gateway_pool"] }, { colors: { cluster_cpu: COL.blue, payments_pod_cpu: COL.watch, gateway_pool: COL.bad } }),
  podsTable: esql("secbank-d6-pods-table", "Pods, last 5 min", `${PF} | WHERE metricset.name == "pod" AND ${last(5)}
    | STATS cpu_pct = ROUND(100 * AVG(kubernetes.pod.cpu.pct), 1), mem_pct = ROUND(100 * MAX(kubernetes.pod.memory.pct), 1), pool_used = MAX(jvm.http_pool.used),
      restarts = MAX(kubernetes.pod.restarts) BY service.name, kubernetes.pod.name, kubernetes.node.name | SORT cpu_pct DESC`,
    [["service.name", "string", "Service"], ["kubernetes.pod.name", "string", "Pod"], ["kubernetes.node.name", "string", "Node"], ["cpu_pct", "number", "CPU %"],
      ["mem_pct", "number", "Memory %"], ["pool_used", "number", "Gateway pool"], ["restarts", "number"]],
    { table: true, colorBy: { cpu_pct: bands([70, 85, 101], [COL.good, COL.watch, COL.bad], 101), mem_pct: bands([80, 90, 101], [COL.good, COL.watch, COL.bad], 101) } }),
  nodesTable: esql("secbank-d6-nodes-table", "Nodes, last 5 min", `${PF} | WHERE metricset.name == "node" AND ${last(5)}
    | STATS cpu_pct = ROUND(100 * AVG(kubernetes.node.cpu.pct), 1), mem_pct = ROUND(100 * AVG(kubernetes.node.memory.pct), 1) BY kubernetes.node.name | SORT kubernetes.node.name`,
    [["kubernetes.node.name", "string", "Node"], ["cpu_pct", "number", "CPU %"], ["mem_pct", "number", "Memory %"]], { table: true }),
  queries: vega("secbank-d6-queries", "Query time per table (ms, box plot)", {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: { index: "metrics-bank.platform-*", "%context%": true, "%timefield%": "@timestamp",
      body: { size: 5000, _source: ["postgresql.table", "postgresql.query.time_ms"] } }, format: { property: "hits.hits" } },
    transform: [{ filter: "datum._source.postgresql && datum._source.postgresql.query" },
      { calculate: "datum._source.postgresql.table", as: "table" }, { calculate: "datum._source.postgresql.query.time_ms", as: "ms" }],
    mark: { type: "boxplot", extent: "min-max" },
    encoding: { y: { field: "table", type: "nominal", title: null }, x: { field: "ms", type: "quantitative", scale: { type: "symlog" }, title: "Query time ms (log scale)" },
      color: { field: "table", type: "nominal", legend: null } },
  }),
  patterns: esql("secbank-d6-patterns", "Log patterns that changed (last 15 min against before)", `FROM logs-bank.app-default | WHERE log.level != "info"
    | EVAL recent = CASE(@timestamp >= ${END} - 15 minutes, 1, 0)
    | STATS last_15_min = SUM(recent), before = COUNT(*) - SUM(recent), services = MV_CONCAT(VALUES(service.name), ", ") BY pattern = CATEGORIZE(message)
    | SORT last_15_min DESC | LIMIT 10 | KEEP pattern, services, last_15_min, before`,
    [["pattern", "string", "Pattern"], ["services", "string", "Services"], ["last_15_min", "number", "Last 15 min"], ["before", "number", "Before"]], { table: true }),
}
dashboard(6, "Infrastructure under the services: nodes, pods, pools, queues and the database. Simulated Kubernetes and PostgreSQL metrics.", [
  [7, [d6.nodes, 8], [d6.pods, 8], [d6.cpu, 8], [d6.pool, 8], [d6.queue, 8], [d6.pg, 8]],
  [13, [d6.saturation, 30], [d1.problems, 18]],
  [12, [d6.podsTable, 32], [d6.nodesTable, 16]],
  [12, [d6.queries, 22], [d6.patterns, 26]],
], [["platform", "service.name", "Service"], ["platform", "kubernetes.node.name", "Node"], ["platform", "orchestrator.cluster.name", "Cluster"]])

// =====================================================================
// D7 Incident Room (select a problem; evidence, never the ground truth)
// =====================================================================
/** Change point of one per-minute signal (ES|QL CHANGE_POINT). */
const changePoint = (id, title, from, where, value) => esql(id, title, `${from} | WHERE ${where}
  | STATS v = ${value} BY minute = BUCKET(@timestamp, 1 minute) | SORT minute | CHANGE_POINT v ON minute AS change, pvalue
  | WHERE change IS NOT NULL | KEEP minute, change, v | SORT minute | LIMIT 3`,
  [["minute", "date", "Moved at"], ["change", "string", "Change"], ["v", "number", "Value"]], { table: true })
const d7 = {
  running: esql("secbank-d7-running", "Impact running", `FROM bank-problems | WHERE problem.status == "open"
    | STATS first_at = MIN(problem.started_at) | EVAL minutes = DATE_DIFF("minute", first_at, ${END}) | KEEP minutes`,
    [["minutes", "number", "Minutes since the first open problem started"]], { metric: "minutes", color: COL.bad }),
  lead: esql("secbank-d7-lead", "Detection lead", `FROM bank-problems | EVAL lead = DATE_DIFF("second", problem.started_at, problem.detected_at) / 60.0
    | STATS minutes = ROUND(AVG(lead), 1), worst = ROUND(MAX(lead), 1) | EVAL detail = CONCAT("worst ", TO_STRING(worst), " min") | KEEP minutes, detail`,
    [["minutes", "number", "Minutes from first failure to detection"], ["detail", "string"]], { metric: "minutes", secondary: "detail" }),
  compression: esql("secbank-d7-compression", "Signals to problems", `FROM bank-problems | WHERE problem.status == "open"
    | STATS problems = COUNT(*), journeys = COUNT_DISTINCT(journey.name) | EVAL detail = CONCAT("across ", TO_STRING(journeys), " journeys") | KEEP problems, detail`,
    [["problems", "number", "Open problems"], ["detail", "string"]], { metric: "problems", secondary: "detail" }),
  saw: esql("secbank-d7-saw", "What the customer saw", `${JEV} AND ${TECH}
    | STATS customers = COUNT_DISTINCT(bank.customer.ref), failures = COUNT(*), first_seen = MIN(@timestamp), last_seen = MAX(@timestamp)
      BY journey.name, journey.step, journey.reason_code, http.response.status_code | SORT failures DESC | LIMIT 12`,
    [["journey.name", "string", "Journey"], ["journey.step", "string", "Step"], ["journey.reason_code", "string", "What they were told"],
      ["http.response.status_code", "number", "HTTP"], ["customers", "number"], ["failures", "number"], ["first_seen", "date", "First"], ["last_seen", "date", "Last"]], { table: true }),
  evidence: esql("secbank-d7-evidence", "Evidence, in time order", `FROM logs-bank.app-default, bank-problems
    | WHERE event.category == "deployment" OR problem.id IS NOT NULL
    | EVAL time = COALESCE(problem.detected_at, @timestamp),
      what = CASE(event.category == "deployment", CONCAT("Deployed ", service.name, " ", service.version),
        CONCAT("Detected (", problem.severity, "): ", problem.title, ", started ", DATE_FORMAT("HH:mm", problem.started_at), " UTC"))
    | SORT time | KEEP time, what`, [["time", "date", "Time"], ["what", "string", "Event"]], { table: true }),
  cpBill: changePoint("secbank-d7-cp-bill", "Signal moved: bill pay completion", `FROM ${BIZ}`, `journey.name == "bill_pay" AND ${TERMINAL}`,
    'AVG(CASE(journey.status == "completed", 1.0, 0.0))'),
  cpGw: changePoint("secbank-d7-cp-gw", "Signal moved: payment_gw latency (ms)", "FROM traces-apm*",
    'processor.event == "span" AND span.destination.service.resource == "payment_gw"', "AVG(span.duration.us) / 1000"),
  cpPool: changePoint("secbank-d7-cp-pool", "Signal moved: gateway pool in use", PF, "jvm.http_pool.used IS NOT NULL", "MAX(jvm.http_pool.used)"),
  cpAutopay: changePoint("secbank-d7-cp-autopay", "Signal moved: autopay runs per minute", `FROM ${BIZ}`, 'event.category == "autopay_run"', "COUNT(*)"),
  ai: markdown("secbank-d7-ai", "AI hypotheses and actions awaiting a human",
    "The agent's latest hypothesis appears on the case, ending with one line from the fixed vocabulary " +
    "**CAUSE: service / component / fault type**. Proposed actions pause for a human in [Workflows](/app/workflows); nothing executes on its own.\n\n" +
    "Scoring against the ground truth happens after the case closes (`api/bin/score-rca.php`, D9). The ground truth is never shown here."),
}
dashboard(7, "One incident end to end: impact, what customers saw, evidence in order, which signal moved first.", [
  [7, [d0.impacted, 8], [d0.cim, 8], [d7.running, 8], [d7.lead, 8], [d7.compression, 8], [d0.var, 8]],
  [10, [d0.openList, 48]],
  [11, [d7.saw, 28], [d7.evidence, 20]],
  [8, [d7.cpGw, 12], [d7.cpBill, 12], [d7.cpPool, 12], [d7.cpAutopay, 12]],
  [8, [d7.ai, 48]],
  [10, [d0.definitions, 48]],
], [["problems", "problem.id", "Incident"], ["problems", "problem.severity", "Severity"]])

// =====================================================================
// D8 Preventive Watch
// =====================================================================
const RISKS = 'FROM bank-risks | WHERE risk.status == "open"'
const d8 = {
  open: esql("secbank-d8-open", "Predictable risks open", `${RISKS} | STATS risks = COUNT(*)`, [["risks", "number", "Open risks"]], { metric: "risks" }),
  due: esql("secbank-d8-due", "Due within 7 days", `${RISKS} AND risk.days_left <= 7 | STATS due = COUNT(*)`, [["due", "number", "Due within 7 days"]], { metric: "due", color: COL.watch }),
  owned: esql("secbank-d8-owned", "With an owner", `${RISKS} | STATS owned = SUM(CASE(risk.owner IS NOT NULL, 1, 0)), total = COUNT(*)
    | EVAL detail = CONCAT("of ", TO_STRING(total)) | KEEP owned, detail`, [["owned", "number", "Risks with an owner"], ["detail", "string"]], { metric: "owned", secondary: "detail" }),
  soonest: esql("secbank-d8-soonest", "Earliest due", `${RISKS} | STATS days = ROUND(MIN(risk.days_left), 1)`,
    [["days", "number", "Days until the next risk is due"]], { metric: "days" }),
  table: esql("secbank-d8-table", "Open predictable risks", `${RISKS} | SORT risk.days_left
    | KEEP risk.type, risk.title, risk.component, risk.days_left, risk.due_at, risk.confidence, risk.owner, risk.source`,
    [["risk.type", "string", "Type"], ["risk.title", "string", "Risk"], ["risk.component", "string", "Component"], ["risk.days_left", "number", "Days left"],
      ["risk.due_at", "date", "Due"], ["risk.confidence", "number", "Confidence"], ["risk.owner", "string", "Owner"], ["risk.source", "string", "Source"]],
    { table: true, colorBy: { "risk.days_left": bands([1, 7, 1e6], [COL.bad, COL.watch, COL.good], 1e6) } }),
  memory: esql("secbank-d8-memory", "notify-svc memory (% of limit)", `${PF} | WHERE metricset.name == "pod" AND service.name == "notify-svc"
    | STATS memory_pct = ROUND(100 * MAX(kubernetes.pod.memory.pct), 1) BY minute = BUCKET(@timestamp, 1 minute) | SORT minute`,
    [["memory_pct", "number", "Memory % of limit"], ["minute", "date"]], { xy: "line", x: "minute", y: ["memory_pct"] }, { colors: { memory_pct: COL.watch } }),
  certs: esql("secbank-d8-certs", "Certificates by days to expiry", `FROM logs-bank.synthetics-default | WHERE tls.server.x509.not_after IS NOT NULL
    | STATS not_after = MAX(tls.server.x509.not_after) BY tls.server.x509.subject.common_name
    | EVAL days = DATE_DIFF("day", ${END}, not_after) | SORT days | KEEP days, tls.server.x509.subject.common_name`,
    [["days", "number", "Days to expiry"], ["tls.server.x509.subject.common_name", "string", "Certificate"]],
    { xy: "bar_horizontal", x: "tls.server.x509.subject.common_name", y: ["days"], labels: true }),
  drift: esql("secbank-d8-drift", "Errors by release", `FROM logs-bank.app-default | WHERE log.level IN ("error", "warn")
    | STATS errors = SUM(CASE(log.level == "error", 1, 0)), warnings = SUM(CASE(log.level == "warn", 1, 0)), first_at = MIN(@timestamp) BY service.name, service.version
    | SORT errors DESC | KEEP service.name, service.version, first_at, errors, warnings`,
    [["service.name", "string", "Service"], ["service.version", "string", "Version"], ["first_at", "date", "First seen"], ["errors", "number"], ["warnings", "number"]], { table: true }),
  third: esql("secbank-d8-third", "Third-party latency trend (p95 ms, 5 min)", DEP.replace("FROM traces-apm* | WHERE", "FROM traces-apm* | WHERE") +
    " | STATS p95_ms = PERCENTILE(span.duration.us, 95) / 1000 BY t = BUCKET(@timestamp, 5 minutes), span.destination.service.resource | SORT t",
    [["p95_ms", "number", "p95 ms"], ["t", "date"], ["span.destination.service.resource", "string", "Dependency"]],
    { xy: "line", x: "t", y: ["p95_ms"], split: "span.destination.service.resource" }),
  method: markdown("secbank-d8-method", "Forecast method and approvals",
    "Risks are written every minute by `api/bin/journey-health.php` into `bank-risks`: certificate expiry from the TLS monitor, " +
    "and pod memory projected to its limit by a least-squares fit over the last hour (confidence = r squared). " +
    "An ML forecast job in Kibana gives the forecast band. Proposed preventive actions wait for a human in [Workflows](/app/workflows)."),
}
dashboard(8, "Predictable risks before they become incidents: certificates, capacity, third parties, release drift.", [
  [7, [d8.open, 12], [d8.due, 12], [d8.owned, 12], [d8.soonest, 12]],
  [10, [d8.table, 48]],
  [12, [d8.memory, 24], [d8.certs, 24]],
  [12, [d8.third, 24], [d8.drift, 24]],
  [6, [d8.method, 48]],
], [["risks", "risk.type", "Risk type"], ["risks", "risk.owner", "Owner"]])

// =====================================================================
// D9 AI Accountability (bank-ai-scores: scored runs; simulated history is labelled labels.data_source = simulator)
// =====================================================================
const AI = "FROM bank-ai-scores"
const d9 = {
  runs: esql("secbank-d9-runs", "Scored runs", `${AI} | STATS runs = COUNT(*), scenarios = COUNT_DISTINCT(scenario.id)
    | EVAL detail = CONCAT("across ", TO_STRING(scenarios), " scenarios") | KEEP runs, detail`, [["runs", "number", "Scored investigations"], ["detail", "string"]], { metric: "runs", secondary: "detail" }),
  top1: esql("secbank-d9-top1", "Top-1 accuracy", `${AI} | STATS top1 = ROUND(100 * AVG(CASE(score.top1_hit, 1.0, 0.0)), 0), top3 = ROUND(100 * AVG(CASE(score.top3_hit, 1.0, 0.0)), 0)
    | EVAL detail = CONCAT("top-3 ", TO_STRING(top3), " %") | KEEP top1, detail`, [["top1", "number", "First answer correct %"], ["detail", "string"]], { metric: "top1", secondary: "detail" }),
  tth: esql("secbank-d9-tth", "Time to first hypothesis", `${AI} | STATS median_s = MEDIAN(score.time_to_hypothesis_s) | EVAL minutes = ROUND(median_s / 60, 1) | KEEP minutes`,
    [["minutes", "number", "Median minutes"]], { metric: "minutes" }),
  approval: esql("secbank-d9-approval", "Approval latency", `${AI} | STATS median_s = MEDIAN(score.approval_latency_s) | EVAL minutes = ROUND(median_s / 60, 1) | KEEP minutes`,
    [["minutes", "number", "Median minutes, paused to decision"]], { metric: "minutes" }),
  work: esql("secbank-d9-work", "Work per investigation", `${AI} | STATS tokens = ROUND(AVG(score.tokens)), tools = ROUND(AVG(score.tool_calls), 1)
    | EVAL detail = CONCAT(TO_STRING(tools), " tool calls") | KEEP tokens, detail`, [["tokens", "number", "Tokens"], ["detail", "string"]], { metric: "tokens", secondary: "detail" }),
  byScenario: esql("secbank-d9-by-scenario", "Accuracy by scenario", `${AI}
    | STATS runs = COUNT(*), top1 = ROUND(100 * AVG(CASE(score.top1_hit, 1.0, 0.0)), 0), top3 = ROUND(100 * AVG(CASE(score.top3_hit, 1.0, 0.0)), 0),
      tth_min = ROUND(MEDIAN(score.time_to_hypothesis_s) / 60, 1) BY scenario.id | SORT top1`,
    [["scenario.id", "string", "Scenario"], ["runs", "number"], ["top1", "number", "Top-1 %"], ["top3", "number", "Top-3 %"], ["tth_min", "number", "Time to hypothesis min"]],
    { table: true, colorBy: { top1: bands([60, 85, 101], [COL.bad, COL.watch, COL.good], 101) } }),
  misses: esql("secbank-d9-misses", "Recent misses", `${AI} | WHERE score.top1_hit == false | SORT @timestamp DESC | LIMIT 15
    | KEEP @timestamp, run.id, scenario.id, agent.level, cause.true, cause.top1, score.top3_hit`,
    [["@timestamp", "date", "Scored"], ["run.id", "string", "Run"], ["scenario.id", "string", "Scenario"], ["agent.level", "string", "Agent"],
      ["cause.true", "string", "True cause"], ["cause.top1", "string", "First answer"], ["score.top3_hit", "boolean", "In top 3"]], { table: true }),
  confusion: vega("secbank-d9-confusion", "True cause against the agent's first answer", {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: { index: "bank-ai-scores", "%context%": true, "%timefield%": "@timestamp", body: { size: 0, aggs: {
      t: { terms: { field: "cause.true", size: 12 }, aggs: { a: { terms: { field: "cause.top1", size: 12 } } } } } } },
      format: { property: "aggregations.t.buckets" } },
    transform: [{ flatten: ["a.buckets"], as: ["ans"] }, { calculate: "replace(datum.key, 'CAUSE: ', '')", as: "truth" },
      { calculate: "replace(datum.ans.key, 'CAUSE: ', '')", as: "answer" }, { calculate: "datum.ans.doc_count", as: "runs" },
      { calculate: "datum.truth == datum.answer ? 'correct' : 'miss'", as: "result" }],
    layer: [
      { mark: { type: "rect", tooltip: true }, encoding: {
        x: { field: "answer", type: "nominal", title: "First answer", axis: { labelAngle: -30, labelLimit: 220 } },
        y: { field: "truth", type: "nominal", title: "True cause", axis: { labelLimit: 260 } },
        color: { field: "result", type: "nominal", scale: { domain: ["correct", "miss"], range: [COL.good, COL.bad] }, title: null },
        opacity: { field: "runs", type: "quantitative", legend: null, scale: { range: [0.35, 1] } },
        tooltip: [{ field: "truth" }, { field: "answer" }, { field: "runs" }] } },
      { mark: { type: "text", color: "white" }, encoding: { x: { field: "answer", type: "nominal" }, y: { field: "truth", type: "nominal" }, text: { field: "runs" } } },
    ],
  }),
  how: markdown("secbank-d9-how", "How runs are scored",
    "Each scenario run writes its ground truth (**CAUSE: service / component / fault type**) to `bank-demo-ledger` before the fault starts. " +
    "The agent never reads it. When the case closes, `api/bin/score-rca.php` compares the agent's first answer (top-1) and up to three answers (top-3) " +
    "with that line and writes one document to `bank-ai-scores`. Misses are listed, not hidden. No model name is shown.\n\n" +
    "Rows with `labels.data_source : simulator` are simulated history (`simulate.php --ai-history`); real scored runs have `labels.data_source : scored`. Measured on simulated faults."),
}
dashboard(9, "How often the AI finds the true cause, how fast, at what cost, and where it misses. Measured on simulated faults.", [
  [7, [d9.runs, 10], [d9.top1, 10], [d9.tth, 9], [d9.approval, 9], [d9.work, 10]],
  [12, [d9.byScenario, 20], [d9.misses, 28]],
  [16, [d9.confusion, 48]],
  [7, [d9.how, 48]],
], [["ai", "scenario.id", "Scenario"], ["ai", "agent.level", "Agent"], ["ai", "labels.data_source", "Source"]], "now-30d")

// =====================================================================
// Canvas wallboard: Pulse, Problems, Pulse (clone), Stack. Canvas has no ES|QL, so elements use Elasticsearch SQL
// (essql). Every element starts with `filters`, so the time filter in the header drives the whole page.
// =====================================================================
const WP = "workpad-secbank-wallboard"
const CANVAS_TIME = (process.env.SECBANK_CANVAS_TIME || "now-60m,now").split(",")
const SQLS = []   // [element label, sql] for --check
const W = { bg: "#000000", text: "#FFFFFF", muted: "#98A2B3", panel: "#0E1116", line: "#1F2630" }
const q = (sql) => sql.replace(/\s*\n\s*/g, " ").trim()
const essql = (label, sql) => (SQLS.push([label, q(sql)]), `filters | essql query="${q(sql).replace(/"/g, '\\"')}"`)
const sev = (v) => `switch case={case if={eq "critical"} then="${COL.bad}"} case={case if={eq "major"} then="${COL.watch}"} case={case if={eq "minor"} then="${COL.blue}"} default="${W.line}"`
const band = `switch case={case if={gte 90} then="${COL.good}"} case={case if={gte 80} then="${COL.watch}"} default="${COL.bad}"`
const font = (size, color = W.text, align = "left", weight = "normal") => `{font size=${size} color="${color}" align="${align}" weight="${weight}" family="'Inter', 'Helvetica Neue', Arial, sans-serif"}`
let elN = 0
// § marks a markdown line break: expressions are collapsed to one line, then § becomes a real newline.
const el = (left, top, width, height, expression) => ({ id: `element-${WP}-${elN++}`, position: { left, top, width, height, angle: 0, parent: null },
  expression: expression.replace(/§/g, "\n") })
const md = (x, y, w, h, text, size = 16, color = W.text) => el(x, y, w, h, `markdown "${text.replace(/"/g, '\\"')}" font=${font(size, color)} openLinksInNewTab=false | render`)
const box = (x, y, w, h, fill = W.panel) => el(x, y, w, h, `shape "square" fill="${fill}" border="${W.line}" borderWidth=1 maintainAspect=false | render`)
/** Big number tile: SQL returning one column v; optional colour switch on the value. */
const tile = (x, y, w, h, label, sql, { fmt = "0,0", color, math = "v", pipe = "" } = {}) => [
  box(x, y, w, h),
  el(x + 16, y + 10, w - 32, h - 20, `${essql(label, sql)}${pipe} | math "${math}" | metric "${label}" metricFormat="${fmt}"
    metricFont=${font(56, color ? `{${color}}` : W.text, "left", "bold").replace(`color="{${color}}"`, `color={${color}}`)} labelFont=${font(16, W.muted)} | render`.replace(/\s*\n\s*/g, " ")),
]
const pageLinks = (active) => ["Pulse", "Problems", "Pulse", "Stack"].map((p, i) => (i === active ? `**${p}**` : `[${p}](#/workpad/${WP}/page/${i + 1})`)).join("  ·  ")
const header = (active, title) => [
  box(0, 0, 1920, 70, W.bg),
  md(24, 14, 700, 44, `**SecBank** · ${title}`, 26),
  md(640, 20, 580, 40, pageLinks(active), 18, W.muted),
  el(1240, 18, 370, 40, `${essql("problem pill", 'SELECT "summary.open" AS v, "summary.critical" AS c FROM "bank-problem-rank" WHERE kind = \'summary\' ORDER BY "@timestamp" DESC LIMIT 1')}
    | markdown "{{#each rows}}**{{v}}** open problems, {{c}} critical{{/each}}" font=${font(18, COL.watch)} | render`.replace(/\s*\n\s*/g, " ")),
  // Default last 60 minutes; SECBANK_CANVAS_TIME="from,to" pins absolute times (a frozen demo, or a screenshot).
  { ...el(1620, 14, 280, 44, 'timefilterControl compact=true column="@timestamp" | render'),
    filter: `timefilter column="@timestamp" from="${CANVAS_TIME[0]}" to="${CANVAS_TIME[1]}"` },
  md(24, 1046, 1300, 30, "Simulated bank data, built by Hexaware on Elastic. Not a Tensai value claim. Every action waits for a human.", 13, W.muted),
]
// JHI from additive counts (same formula as bank-journey-health / D0), in Elasticsearch SQL.
const JHI_SQL = `100 * (0.4 * LEAST(1.0, (SUM("health.completed") * 1.0 / SUM("health.attempts")) / (MAX("health.slo_completion_pct") / 100.0))
  + 0.25 * ((SUM("health.satisfied") + SUM("health.tolerating") / 2.0) / SUM("health.attempts"))
  + 0.2 * GREATEST(0.0, 1 - (SUM("health.tech_failures") * 1.0 / SUM("health.attempts")) / 0.05)
  + 0.15 * (CASE WHEN SUM("health.page_views") > 0 THEN SUM("health.page_views_pass") * 1.0 / SUM("health.page_views") ELSE 1.0 END))`
const JOURNEY_TILES = ["bill_pay", "login", "view_accounts", "card_payment", "p2p_transfer", "card_controls", "autopay_setup", "onboarding", "loan_apply", "dispute"]
const SLOT_TEXT = `{{#each rows}}**{{severity}}** · {{title}}§§Started {{started}} · detected {{detected}} · {{owner}}§§{{#if customers}}**{{customers}}** customers · {{/if}}**\${{var}}** at risk{{/each}}`

function pulse(pageIdx) {
  const els = [...header(pageIdx, "Pulse")]
  const T = [
    ["Journey completion %", `SELECT 100.0 * SUM(CASE WHEN "journey.status" = 'completed' THEN 1 ELSE 0 END) / COUNT(*) AS v FROM "${BIZ}"
      WHERE "event.category" = 'journey' AND "journey.status" IN ('completed', 'failed', 'abandoned', 'pending')`, { fmt: "0.0", color: "switch case={case if={gte 99} then=\"" + COL.good + "\"} case={case if={gte 97} then=\"" + COL.watch + "\"} default=\"" + COL.bad + "\"" }],
    ["Customers impacted", `SELECT COUNT(DISTINCT "bank.customer.ref") AS v FROM "${BIZ}" WHERE "journey.failure_class" = 'technical'`, {}],
    ["Value at risk, USD", `SELECT SUM("bank.txn.amount") AS v FROM "${BIZ}" WHERE "journey.failure_class" = 'technical'`, { fmt: "$0.0a" }],
    // Elasticsearch SQL cannot aggregate an aggregate: return the qualifying rows, count them in Canvas.
    ["Journeys healthy (index 90+)", `SELECT "journey.name" AS j, ${JHI_SQL} AS h FROM "bank-journey-health" GROUP BY j HAVING h >= 90`, { math: "count(h)" }],
    // Percentiles cannot be used in HAVING / ORDER BY in Elasticsearch SQL: filter and sort in Canvas instead.
    ["Services in SLO (p95 3 s)", `SELECT "service.name" AS s, PERCENTILE("transaction.duration.us", 95) AS p FROM "traces-apm*"
      WHERE "processor.event" = 'transaction' GROUP BY s`, { math: "count(p)", pipe: ' | filterrows fn={getCell "p" | lte 3000000}' }],
    ["Open problems", `SELECT "summary.open" AS v FROM "bank-problem-rank" WHERE kind = 'summary' ORDER BY "@timestamp" DESC LIMIT 1`, {}],
  ]
  T.forEach(([label, sql, o], i) => els.push(...tile(24 + i * 314, 88, 298, 150, label, sql, o)))
  // Journey health tiles, fill by the index band.
  els.push(md(24, 254, 600, 30, "Journey health", 18, W.muted))
  JOURNEY_TILES.forEach((j, i) => {
    const x = 24 + (i % 5) * 188, y = 290 + Math.floor(i / 5) * 128
    const sql = `SELECT ${JHI_SQL} AS v FROM "bank-journey-health" WHERE "journey.name" = '${j}'`
    els.push(el(x, y, 176, 116, `${essql(`tile ${j}`, sql)} | math "v" | shape "square" fill={${band}} border="${W.line}" maintainAspect=false | render`))
    els.push(el(x + 10, y + 6, 156, 104, `${essql(`tile ${j} value`, sql)} | math "v" | metric "${j.replace(/_/g, " ")}" metricFormat="0"
      metricFont=${font(40, "#0B0F14", "left", "bold")} labelFont=${font(15, "#0B0F14")} | render`.replace(/\s*\n\s*/g, " ")))
  })
  // Technology stack summary (worst first).
  els.push(md(24, 556, 940, 30, "Technology stack, p95 and errors", 18, W.muted))
  els.push(el(24, 590, 940, 300, `${essql("stack", `SELECT "service.name" AS s, ROUND(PERCENTILE("transaction.duration.us", 95) / 1000) AS p95,
      ROUND(100.0 * SUM(CASE WHEN "event.outcome" = 'failure' THEN 1 ELSE 0 END) / COUNT(*), 1) AS err FROM "traces-apm*"
      WHERE "processor.event" = 'transaction' GROUP BY s`)} | sort by="p95" reverse=true | head 9
    | markdown "| Service | p95 ms | errors % |§|---|--:|--:|§{{#each rows}}| {{s}} | {{p95}} | {{err}} |§{{/each}}" font=${font(17)} | render`.replace(/\s*\n\s*/g, " ")))
  // Four problem slots (bank-problem-rank, severity then value at risk; free slots show the next risk).
  els.push(md(990, 254, 600, 30, "Open problems, by severity then value at risk", 18, W.muted))
  for (let s = 1; s <= 4; s++) {
    const y = 290 + (s - 1) * 152
    const base = `FROM "bank-problem-rank" WHERE slot = ${s}`
    els.push(box(990, y, 906, 140))
    els.push(el(990, y, 10, 140, `${essql(`slot ${s} bar`, `SELECT COALESCE("problem.severity", kind) AS v ${base}`)} | getCell "v" | shape "square" fill={${sev()}} border="${W.line}" maintainAspect=false | render`))
    els.push(el(1016, y + 8, 870, 126, `${essql(`slot ${s}`, `SELECT "problem.severity" AS severity, "problem.title" AS title, "problem.owner" AS owner,
        DATETIME_FORMAT("problem.started_at", 'HH:mm') AS started, DATETIME_FORMAT("problem.detected_at", 'HH:mm') AS detected,
        "impact.customers" AS customers, ROUND("impact.value_at_risk") AS var, kind, "risk.title" AS risk ${base}`)}
      | markdown "${SLOT_TEXT.replace(/"/g, '\\"')}{{#each rows}}{{#if risk}}Predicted: {{risk}}{{/if}}{{/each}}" font=${font(17)} | render`.replace(/\s*\n\s*/g, " ")))
  }
  // Value at risk per minute.
  els.push(md(990, 900, 600, 30, "Value at risk per minute, USD", 16, W.muted))
  els.push(el(990, 930, 906, 110, `${essql("var trend", `SELECT HISTOGRAM("@timestamp", INTERVAL 1 MINUTE) AS t, SUM("bank.txn.amount") AS v FROM "${BIZ}"
      WHERE "journey.failure_class" = 'technical' GROUP BY t`)}
    | pointseries x="t" y="v" | plot defaultStyle={seriesStyle lines=0 bars=0 points=0 fill=true} palette={palette "${COL.bad}"} legend=false
      xaxis=false yaxis=true font=${font(12, W.muted)} | render`.replace(/\s*\n\s*/g, " ")))
  els.push(md(24, 900, 940, 30, "Gateway latency, p95 ms per minute", 16, W.muted))
  els.push(el(24, 930, 940, 110, `${essql("gw trend", `SELECT HISTOGRAM("@timestamp", INTERVAL 1 MINUTE) AS t, PERCENTILE("span.duration.us", 95) / 1000 AS v FROM "traces-apm*"
      WHERE "span.destination.service.resource" = 'payment_gw' GROUP BY t`)}
    | pointseries x="t" y="v" | plot defaultStyle={seriesStyle lines=2 points=0} palette={palette "${COL.watch}"} legend=false xaxis=false yaxis=true font=${font(12, W.muted)} | render`.replace(/\s*\n\s*/g, " ")))
  return els
}

function problemsPage() {
  const els = [...header(1, "Problems")]
  const S = (k) => `SELECT "summary.${k}" AS v FROM "bank-problem-rank" WHERE kind = 'summary' ORDER BY "@timestamp" DESC LIMIT 1`
  ;[["Open problems", S("open")], ["Critical", S("critical")], ["Major", S("major")], ["Minor", S("minor")], ["Ranked 5 and below", S("overflow")],
    ["Predicted risks", S("risks")]].forEach(([label, sql], i) => els.push(...tile(24 + i * 314, 88, 298, 130, label, sql)))
  for (let s = 1; s <= 4; s++) {
    const x = 24 + ((s - 1) % 2) * 944, y = 236 + Math.floor((s - 1) / 2) * 260
    const base = `FROM "bank-problem-rank" WHERE slot = ${s}`
    els.push(box(x, y, 928, 244))
    els.push(el(x, y, 12, 244, `${essql(`card ${s} bar`, `SELECT COALESCE("problem.severity", kind) AS v ${base}`)} | getCell "v" | shape "square" fill={${sev()}} border="${W.line}" maintainAspect=false | render`))
    els.push(el(x + 28, y + 12, 880, 224, `${essql(`card ${s}`, `SELECT "problem.id" AS id, "problem.severity" AS severity, "problem.title" AS title, "problem.owner" AS owner,
        DATETIME_FORMAT("problem.started_at", 'HH:mm') AS started, DATETIME_FORMAT("problem.detected_at", 'HH:mm') AS detected,
        "impact.customers" AS customers, ROUND("impact.value_at_risk") AS var, "bank.dependency" AS dep, "service.name" AS svc, "bank.region" AS region,
        "risk.title" AS risk, "risk.owner" AS risk_owner ${base}`)}
      | markdown "{{#each rows}}{{#if id}}### {{severity}} · {{title}}§§{{id}} · started {{started}}, detected {{detected}} · owner **{{owner}}**§§{{#if customers}}**{{customers}}** customers · {{/if}}**\${{var}}** at risk§§Evidence: {{svc}} {{dep}} {{region}}§§[Open the Incident Room](/app/dashboards#/view/secbank-d7) and pick {{id}}
{{else}}{{#if risk}}### Predicted · {{risk}}\n\nOwner {{risk_owner}}. Not yet a problem.{{else}}### Free slot\n\nNo open problem or predicted risk.{{/if}}{{/if}}{{/each}}" font=${font(17)} | render`.replace(/\s*\n\s*/g, " ")))
  }
  els.push(md(24, 760, 940, 30, "All open problems", 18, W.muted))
  els.push(el(24, 794, 940, 240, `${essql("all problems", `SELECT "problem.severity" AS severity, "problem.title" AS title, ROUND("impact.value_at_risk") AS var
      FROM "bank-problems" WHERE "problem.status" = 'open' ORDER BY "problem.severity_rank", "impact.value_at_risk" DESC LIMIT 8`)}
    | markdown "{{#each rows}}**{{severity}}** · {{title}} · \${{var}}§§{{/each}}" font=${font(16)} | render`.replace(/\s*\n\s*/g, " ")))
  els.push(md(990, 760, 900, 30, "Predicted, not yet problems", 18, W.muted))
  els.push(el(990, 794, 906, 240, `${essql("risks", `SELECT "risk.title" AS title, "risk.owner" AS owner, ROUND("risk.days_left", 1) AS d FROM "bank-risks"
      WHERE "risk.status" = 'open' ORDER BY "risk.days_left" LIMIT 6`)}
    | markdown "{{#each rows}}**{{d}} days** · {{title}} · {{owner}}§§{{else}}No predicted risks.{{/each}}" font=${font(16)} | render`.replace(/\s*\n\s*/g, " ")))
  return els
}

function stackPage() {
  const els = [...header(3, "Stack")]
  els.push(md(24, 88, 900, 30, "Services, p95 and errors (worst first)", 18, W.muted))
  els.push(el(24, 122, 900, 420, `${essql("services", `SELECT "service.name" AS s, MAX("service.version") AS v, ROUND(PERCENTILE("transaction.duration.us", 95) / 1000) AS p95,
      ROUND(100.0 * SUM(CASE WHEN "event.outcome" = 'failure' THEN 1 ELSE 0 END) / COUNT(*), 1) AS err FROM "traces-apm*"
      WHERE "processor.event" = 'transaction' GROUP BY s`)} | sort by="p95" reverse=true
    | markdown "| Service | version | p95 ms | errors % |§|---|---|--:|--:|§{{#each rows}}| {{s}} | {{v}} | {{p95}} | {{err}} |§{{/each}}" font=${font(17)} | render`.replace(/\s*\n\s*/g, " ")))
  const ring = (x, y, label, sql, shape = "wheel") => [box(x, y, 300, 250),
    md(x + 16, y + 10, 270, 28, label, 16, W.muted),
    el(x + 40, y + 44, 220, 190, `${essql(label, sql)} | math "min(1, v)" | progress shape="${shape}" max=1 valueWeight=24 barWeight=24 barColor="${W.line}"
      valueColor={switch case={case if={gte 0.9} then="${COL.bad}"} case={case if={gte 0.7} then="${COL.watch}"} default="${COL.good}"}
      label={formatnumber "0%"} font=${font(30, W.text, "center", "bold")} | render`.replace(/\s*\n\s*/g, " "))]
  els.push(...ring(950, 122, "payment_gw p95 against 3 s SLO", `SELECT PERCENTILE("span.duration.us", 95) / 3000000.0 AS v FROM "traces-apm*" WHERE "span.destination.service.resource" = 'payment_gw'`, "semicircle"))
  els.push(...ring(1266, 122, "Cluster CPU", `SELECT AVG("kubernetes.node.cpu.pct") AS v FROM "metrics-bank.platform-default" WHERE "metricset.name" = 'node'`))
  els.push(...ring(1582, 122, "Gateway pool, payments-svc", `SELECT MAX("jvm.http_pool.used") * 1.0 / MAX("jvm.http_pool.max") AS v FROM "metrics-bank.platform-default" WHERE "jvm.http_pool.max" IS NOT NULL`))
  const DM = [["PostgreSQL connections", `SELECT MAX("postgresql.connections") AS v FROM "metrics-bank.platform-default" WHERE "metricset.name" = 'postgresql'`],
    ["Lock waits", `SELECT MAX("postgresql.lock_waits") AS v FROM "metrics-bank.platform-default" WHERE "metricset.name" = 'postgresql'`],
    ["Retry queue depth", `SELECT MAX("queue.depth") AS v FROM "metrics-bank.platform-default" WHERE "metricset.name" = 'queue'`]]
  DM.forEach(([label, sql], i) => els.push(...tile(950 + i * 316, 390, 300, 152, label, sql)))
  els.push(md(24, 560, 900, 30, "Synthetic checks (latest run per monitor and location)", 18, W.muted))
  els.push(el(24, 594, 900, 300, `${essql("synthetics", `SELECT "monitor.name" AS m, "observer.geo.name" AS loc, MIN("summary.up") AS worst, COUNT(*) AS runs
      FROM "logs-bank.synthetics-default" GROUP BY m, loc ORDER BY worst, m LIMIT 12`)}
    | markdown "{{#each rows}}{{#if worst}}up{{else}}**DOWN**{{/if}} · {{m}} · {{loc}}  §{{/each}}" font=${font(15)} | render`.replace(/\s*\n\s*/g, " ")))
  els.push(md(950, 560, 940, 30, "Error log lines per minute", 18, W.muted))
  els.push(el(950, 594, 946, 150, `${essql("errors trend", `SELECT HISTOGRAM("@timestamp", INTERVAL 1 MINUTE) AS t, COUNT(*) AS v FROM "logs-bank.app-default"
      WHERE "log.level" IN ('error', 'warn') GROUP BY t`)}
    | pointseries x="t" y="v" | plot defaultStyle={seriesStyle lines=2 points=0} palette={palette "${COL.bad}"} legend=false xaxis=false yaxis=true font=${font(12, W.muted)} | render`.replace(/\s*\n\s*/g, " ")))
  els.push(md(950, 760, 940, 30, "Log patterns (computed at ingest)", 18, W.muted))
  els.push(el(950, 794, 946, 140, `${essql("patterns", `SELECT "bank.log_pattern" AS p, COUNT(*) AS n FROM "logs-bank.app-default" WHERE "log.level" IN ('error', 'warn', 'debug')
      GROUP BY p ORDER BY n DESC LIMIT 4`)} | markdown "{{#each rows}}**{{n}}** · {{p}}  §{{/each}}" font=${font(15)} | render`.replace(/\s*\n\s*/g, " ")))
  els.push(md(24, 910, 900, 30, "Where the problems sit", 18, W.muted))
  els.push(el(24, 944, 900, 96, `${essql("where", `SELECT "problem.severity" AS s, COALESCE("bank.dependency", "service.name", "bank.branch.id", "bank.region") AS c, "problem.owner" AS o
      FROM "bank-problems" WHERE "problem.status" = 'open' ORDER BY "problem.severity_rank" LIMIT 4`)}
    | markdown "{{#each rows}}**{{s}}** · {{c}} · {{o}}  §{{else}}No open problems.{{/each}}" font=${font(15)} | render`.replace(/\s*\n\s*/g, " ")))
  return els
}

const page = (i, elements) => ({ id: `page-${WP}-${i}`, style: { background: W.bg }, transition: {}, elements, groups: [] })
const now = new Date().toISOString()
add({
  id: WP, type: "canvas-workpad", ...MIG, references: [],
  attributes: { name: "SecBank wallboard", id: WP, width: 1920, height: 1080, page: 0,
    // Autoplay order Pulse, Problems, Pulse, Stack: Pulse gets twice the wall time (one interval for the whole workpad).
    pages: [page(0, pulse(0)), page(1, problemsPage()), page(2, pulse(2)), page(3, stackPage())],
    colors: [COL.good, COL.watch, COL.bad, COL.blue, W.text, W.muted, W.bg], variables: [], assets: {}, isWriteable: true,
    css: ".canvasPage { background: #000000; } .canvasMarkdown, .canvasMarkdown * { color: #FFFFFF; } .canvasMarkdown a { color: #6092C0; } .canvasMarkdown table { width: 100%; } .canvasMarkdown td, .canvasMarkdown th { padding: 4px 8px; border-bottom: 1px solid #1F2630; }",
    "@timestamp": now, "@created": now },
})

// =====================================================================
// write + self-check (+ optional live check of every ES|QL and SQL query)
// =====================================================================
const args = process.argv.slice(2)
const keyed = new Set(objects.map((o) => `${o.type}:${o.id}`))
if (keyed.size !== objects.length) throw new Error("duplicate saved-object id")
for (const o of objects) for (const r of o.references)
  if (!keyed.has(`${r.type}:${r.id}`) && !(args.includes("--partial") && r.type === "dashboard")) throw new Error(`${o.id} -> missing ${r.type}:${r.id}`)

if (args.includes("--check")) {
  const es = (args.find((a) => /^https?:/.test(a)) || process.env.ES_URL || "http://127.0.0.1:9200").replace(/\/$/, "")
  const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d
  const to = new Date(Number(opt("to", Date.now() / 1000)) * 1000)
  const from = new Date(to.getTime() - Number(opt("minutes", 60)) * 60000)
  const headers = { "Content-Type": "application/json", ...(process.env.ES_BANK_API_KEY ? { Authorization: `ApiKey ${process.env.ES_BANK_API_KEY}` } : {}) }
  let bad = 0
  for (const o of objects.filter((x) => x._esql)) {
    // Lens adds the dashboard time range as a filter on @timestamp; the check does the same.
    const body = { query: o._esql.query, params: [{ _tstart: from.toISOString() }, { _tend: to.toISOString() }],
      ...(o._esql.time ? { filter: { range: { "@timestamp": { gte: from.toISOString(), lte: to.toISOString() } } } } : {}) }
    const r = await fetch(`${es}/_query?format=json`, { method: "POST", headers, body: JSON.stringify(body) })
    const j = await r.json()
    const got = Object.fromEntries((j.columns || []).map((c) => [c.name, c.type]))
    const typeOk = (want, have) => ({ number: ["long", "integer", "double", "unsigned_long", "counter_long", "counter_double"], string: ["keyword", "text"],
      date: ["date", "date_nanos"], boolean: ["boolean"] }[want] || []).includes(have)
    const miss = o._esql.cols.filter(([n, t]) => !typeOk(t, got[n])).map(([n, t]) => `${n}:${t}->${got[n] ?? "missing"}`)
    const rows = (j.values || []).length
    if (!r.ok || miss.length) { bad++; console.log(`FAIL ${o.id}: ${r.ok ? miss.join(", ") : JSON.stringify(j.error?.reason ?? j).slice(0, 300)}`) }
    else console.log(`ok   ${o.id} (${rows} rows)${rows ? "  " + JSON.stringify(j.values[0]).slice(0, 110) : "  EMPTY"}`)
  }
  console.log(`\n${objects.filter((x) => x._esql).length - bad} ES|QL panels ok, ${bad} failed`)
  // Canvas SQL, with the time filter Canvas applies through `filters`.
  let badSql = 0
  const seen = new Set()
  for (const [label, sql] of SQLS) {
    if (seen.has(sql)) continue
    seen.add(sql)
    const r = await fetch(`${es}/_sql?format=json`, { method: "POST", headers, body: JSON.stringify({ query: sql,
      filter: { range: { "@timestamp": { gte: from.toISOString(), lte: to.toISOString() } } } }) })
    const j = await r.json()
    if (!r.ok) { badSql++; console.log(`FAIL canvas ${label}: ${JSON.stringify(j.error?.reason ?? j).slice(0, 300)}`) }
    else console.log(`ok   canvas ${label} (${(j.rows || []).length} rows)  ${JSON.stringify((j.rows || [])[0] ?? "EMPTY").slice(0, 100)}`)
  }
  console.log(`${seen.size - badSql} Canvas SQL queries ok, ${badSql} failed`)
  if (bad || badSql) process.exitCode = 1
}

const out = fileURLToPath(new URL("./secbank-dashboards.ndjson", import.meta.url))
writeFileSync(out, objects.map(({ _esql, ...o }) => JSON.stringify(o)).join("\n") + "\n")
console.log(`wrote ${objects.length} saved objects -> ${out}`)
