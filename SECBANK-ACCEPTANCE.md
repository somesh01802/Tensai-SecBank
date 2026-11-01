# SecBank dashboards: acceptance report

What was built against the SVP specification (1-SecBank-Dashboards, 2-SecBank-Wallboard-Canvas, 3-Build-Pack,
4-Plan), how each part was checked, and where it differs. Numbers are simulated bank data, not a Tensai value claim.

**How it was checked.** All objects were imported into Kibana 9.5.5 (same version as the deployment) on a local
Elasticsearch 9.5.5 loaded with the four-problem run (`simulate.php --backfill=60 --run=four`, detection replayed at the
freeze time). Every ES|QL panel (105) and Canvas SQL query (50) runs in `node kibana/build-secbank.mjs --check`; every
dashboard and Canvas page was rendered in a headless browser and inspected. Not yet checked on the production
deployment: that happens after the runbook in MIGRATION.md (Upgrade 0008).

**Status key.** Met: built as specified. Fallback: the spec's own fallback, or an equivalent on our indices, because
the Kibana object it needs (SLO, rule, ML job, monitor, case, workflow, agent) does not exist yet. Gap: not built.

## Frozen numbers, four-problem run

| Measure | Spec (17:46) | Measured | Note |
|---|---|---|---|
| Journey completion | 96.3 % (49,988 of 51,890) | 96.5 % (50,166 of 52,007) | Met |
| Bill pay health index | 61 | 61 to 62 (two runs) | Met |
| Bill pay completion | 82.3 % | 84.9 % | close |
| Journeys healthy | 5 of 10 | 4 of 10 | index 90+ and no open problem attached (autopay excluded by P2), last 10 min |
| Open problems | 4 (critical, major, major, minor) | 4, same severities, same order | Met |
| Problem owners | Payments, Payments, Identity, Branch network | same | Met |
| Branches online | 39 of 40 | 39 of 40 | Met |
| Synthetic runs passing | 273 of 288 | 274 of 288 | Met |
| payment_gw p95 | 9.8 s | 10.0 s | Met |
| Gateway calls timed out | 27.3 % | 35 % | higher |
| payments-svc errors | 9.6 % | 10.7 % | close |
| payments-svc p95 | 28.1 s | 40.1 s | higher (3 retries of 10 s timeouts) |
| Gateway pool / retry queue | 200 of 200 / 1,150 | 200 of 200 / 1,154 | Met |
| Value at risk, P1 failed | $412.8k | about $476k (problem card) | close |
| Autopay delayed (P2) | $286.0k | $303.4k | close |
| OTP Northeast (P3) | 610 customers, $38.2k | 468 customers, $24.9k | lower |
| Branch BR-017 delayed (P4) | $9.6k | $9.5k | Met |
| Customers impacted, last 15 min | 3,990 | 1,360 | see note 1 |
| Services and deps in SLO | 9 of 12 (payments-svc, payment_gw, sms_otp) | 9 of 12, the same three breaching | Met |

1. The spec's 2,140 (S1 alone) is more than every bill pay customer in 15 minutes at the spec's own volumes; the
   simulator matches the hour-level numbers (attempts, completion, health index) instead.
2. SLO bar used on D5: p95 up to 3 s and errors up to 2 %, over 9 services (web-ui included, as a browser agent) and
   3 external dependencies.

## D0 Bank Pulse

| Spec panel | Built as | Status |
|---|---|---|
| Controls (channel, segment, region, journey) | options list controls, pinned | Met |
| Journeys healthy | ES|QL over the health index and open problems | Met |
| Customers impacted now | ES|QL, technical failure or step beyond target (LOOKUP JOIN step catalogue), last 15 min | Met |
| Value at risk this hour | ES|QL: technical failures plus pending past 15 min | Met (delayed autopay/branch value is on the problem cards) |
| Journey completion | ES|QL metric with "x of y attempts" | Met |
| Customer-impact minutes | ES|QL, per-minute distinct impacted, summed over the time range | Met |
| Open business incidents | ES|QL on `bank-problem-rank` summary | Fallback (problems, not alert documents) |
| Journey scorecard | ES|QL table, health index coloured by band, SLO burn rate | Met (error budget left replaced by burn rate: 30-day budget needs 30 days) |
| Value at risk per minute | ES|QL stacked area (failed, pending) | Met (annotations: see D4 releases, D7 evidence) |
| Journey health index, every 2 minutes | Vega-Lite heatmap, follows filters and time | Met |
| Transactions by channel | ES|QL bar, includes teller and ATM transactions | Met |
| Customers impacted by segment | ES|QL bar | Met |
| Journey SLOs burning fastest | ES|QL table on `bank-journey-health`; the 10 journey SLOs and burn-rate rules exist (setup-kibana.mjs) | Met (panel is ES|QL, not the SLO embeddable) |
| Open incidents list | ES|QL table on the ranked problems | Fallback (no Cases yet) |
| Definitions | Markdown | Met |

## D1 Journeys

| Spec panel | Built as | Status |
|---|---|---|
| Journey control pre-set | options list, bill pay selected | Met (no ES|QL variable control for "pending SLA"; fixed at 15 min) |
| Health index, started, completed, impacted, value at risk, time to complete | ES|QL metrics | Met |
| Started, completed and lost per minute | ES|QL line, three series | Met |
| Active alerts and case | open problems for the journey | Fallback |
| Step funnel | ES|QL bar, reached and lost per step | Met (Lens bar, not a Vega funnel) |
| Why step 4 fails | ES|QL bar by reason and failure class | Met |
| Why the health index is 61 | ES|QL table of C, A, E, X | Met |
| Bill pay completion SLO | ES|QL burn rate, time range and 5 min | Fallback |
| Step latency against target | ES|QL with LOOKUP JOIN `bank-journey-steps` | Met |
| Pending payments by age | ES|QL bar | Met |
| Time to complete distribution | ES|QL histogram | Met (no reference line) |
| Core Web Vitals per step page | ES|QL table on simulated page views | Met |
| Synthetic bill pay journey | ES|QL table on simulated synthetic runs | Fallback |
| Failures by channel, segment, region | three ES|QL bars | Met |
| Impacted customers, highest value first | ES|QL table, pseudonymous refs | Met |
| Completion by cohort | ES|QL table by browser and device | Met (table, not Vega small multiples) |

## D2 Branches

| Spec panel | Built as | Status |
|---|---|---|
| Branches online, teller and ATM transactions, ATMs online | ES|QL metrics (ATMs from heartbeats) | Met |
| Branch health index | in-person journey completion | Fallback (the index is per journey, not per channel) |
| Regions with impacted digital customers | ES|QL, regions over 2 % technical failures on digital payment journeys | Met (6 of 6) |
| Branches by region map | Maps panel, one point per branch coloured by region | Met (no region boundary term join) |
| Active alerts | branch problems | Fallback |
| Regions table | ES|QL | Met |
| ATM synthetic checks | ES|QL on simulated ATM probes | Fallback |
| Branch volume against failure rate | Vega-Lite bubble chart | Met |

## D3 Customer Lens

| Spec panel | Built as | Status |
|---|---|---|
| Customer ref control | options list on `bank.customer.ref` | Met (not an ES|QL variable control) |
| Customer, journeys, failed now, value not paid, device, experience | ES|QL | Met |
| Journey trail | ES|QL table with trace id | Met |
| What happened at 17:41 | covered by the trail (journey id column) | Fallback |
| Logs for this customer | Discover session of the customer's failed steps | Met |
| Zero raw PII, checked live | ES|QL: emails in logs (0), non-pseudonymous ids (0 of 159,493) | Met |

## D4 Experience

| Spec panel | Built as | Status |
|---|---|---|
| Page views, vitals pass, LCP, INP, CLS | ES|QL on simulated page views | Met (simulated views carry vitals; the real app's RUM is in the User Experience app) |
| JS errors, JS errors by release | ES|QL on simulated JS errors (0.4 % of views, 3 % after the S4 release) | Met |
| Synthetic availability | ES|QL, 274 of 288 runs | Fallback |
| Page experience over time | ES|QL line, LCP p75 against backend p95 | Met (releases table instead of annotations) |
| Experience against backend gap | ES|QL table by page | Met (table, not a Vega scatter) |
| Vitals by device and browser | ES|QL table | Met |
| Synthetic monitors against real-user completion | ES|QL across both indices | Met |
| Partner API | ES|QL table | Met |

## D5 Services

| Spec panel | Built as | Status |
|---|---|---|
| Services in SLO, payments-svc errors and latency, payment_gw latency | ES|QL on `traces-apm*` (10 % sampled, extrapolated) | Met / Fallback (no SLO objects) |
| Third-party failure share, attribution coverage | ES|QL on business events (98.5 %, 100 %) | Met |
| Latency per minute | ES|QL line per service | Met |
| Service map | link to the APM service map; edges web-ui → api-gateway → services → dependencies come from simulated traces | Fallback (embeddable not confirmed for 9.5) |
| Services table, external dependencies | ES|QL tables | Met |
| Slowest failing traces | Discover session; open one for the waterfall | Met |
| Correlations, anomaly swimlane | links to APM and ML; ML jobs secbank-payment-gw-latency and others exist | Fallback |

## D6 Platform

| Spec panel | Built as | Status |
|---|---|---|
| Nodes, pods, cluster CPU, gateway pool, retry queue, PostgreSQL | ES|QL on simulated platform metrics | Met (simulated, not Kubernetes/PostgreSQL integrations) |
| Saturation over time | ES|QL line, three series | Met |
| Active alerts | problems | Fallback |
| Pods, nodes | ES|QL tables | Met |
| Query time per table | Vega-Lite box plot | Met |
| Log patterns that changed | ES|QL CATEGORIZE, last 15 min against before | Met |

## D7 Incident Room

| Spec panel | Built as | Status |
|---|---|---|
| Incident control | options list on `problem.id` | Fallback (problems, not cases) |
| Customers impacted, impact minutes, impact running, detection lead | ES|QL (detection lead 4.8 min average) | Met |
| Alerts to cases | open problems and journeys | Fallback |
| What the customer saw | ES|QL table | Met |
| Evidence, in time order | ES|QL: deployments and detections | Met |
| Which signal moved first | ES|QL CHANGE_POINT per signal: payment_gw 18:43, pool 18:44, bill pay completion 18:46, autopay 18:30 | Met (four tables, not one Vega timeline) |
| AI hypotheses, actions awaiting a human, case | Markdown with the CAUSE vocabulary and a Workflows link | Gap (needs Agent Builder, Workflows, Cases) |

## D8 Preventive Watch

| Spec panel | Built as | Status |
|---|---|---|
| Risks open, due within 7 days, with an owner, earliest due | ES|QL on `bank-risks` | Met ("preempted this month" replaced: closed risks are not kept with their due date) |
| Open predictable risks | ES|QL table (S7: certificate 7 days; S8: notify-svc memory 5.5 h) | Met |
| notify-svc memory history and forecast | ES|QL line; linear fit in `bank-risks`; ML job secbank-pod-memory with a 1-day forecast (Single Metric Viewer) | Met |
| Certificates by days to expiry | ES|QL bar | Met |
| Error drift after release, third-party trend | ES|QL table and line | Met |
| Proposals awaiting approval | link to Workflows | Gap |

## D9 AI Accountability

| Spec panel | Built as | Status |
|---|---|---|
| Scored runs, top-1 accuracy, time to first hypothesis, approval latency, work per investigation | ES|QL on `bank-ai-scores` | Met (data is simulated history until real runs are scored with `bin/score-rca.php`) |
| Accuracy by scenario, recent misses | ES|QL tables | Met |
| True cause against first answer | Vega-Lite confusion matrix | Met |
| How runs are scored, definitions | Markdown | Met |

## Canvas wallboard

| Spec page | Built as | Status |
|---|---|---|
| Rotation | pages Pulse, Problems, Pulse, Stack; presentation mode autoplay | Met |
| Pulse | six headline metrics, ten journey tiles coloured by the health band, four ranked problem slots (free slots show the next risk), stack table, gateway latency and value-at-risk plots | Met (Elasticsearch SQL plots instead of Timelion; "customers impacted" counts technical failures only) |
| Problems | six counts, four problem cards with owner and evidence, all open problems, predicted risks | Met |
| Stack | services table, payment_gw gauge, cluster CPU and gateway pool wheels, PostgreSQL and queue metrics, synthetic checks, error lines, log patterns, where the problems sit | Met (a table instead of 22 separate chips) |

## Data contract and safety

| Requirement | Check | Result |
|---|---|---|
| One event per journey step with the spec fields | tests/journeys.php, tests/bank-es.php | 19/19, 15/15 |
| Real and simulated activity distinguishable | `labels.data_source` (app, simulator, detector, scored) and `labels.synthetic_user` | Met |
| Ground truth never in telemetry | tests/simulator.php; no panel reads `bank-demo-ledger` | Met |
| Problems from signals only | tests/problems.php: four-problem run gives exactly the four, quiet hour gives none | 11/11 |
| No PII in observability data | D3 live checks; customer ref is a keyed hash | Met |
| Existing data untouched | 0008 is additive; integration suite on the real-app paths | 77/77 |
| Retention | ILM `bank-30d` (30 days), health index 90 days | Met |

## Before the demo

1. Run the deployment in MIGRATION.md (Upgrade 0008), then import `kibana/secbank-dashboards.ndjson`.
2. Optional but recommended: a week of baseline (`--backfill=10080 --scale=0.1`) so ML jobs can learn.
3. Run `kibana/setup-kibana.mjs` (MIGRATION.md): 10 journey SLOs with burn-rate rules, a rule on open problems,
   payments-svc error-rate and latency rules, ML jobs for autopay volume, payment_gw latency, branch volume and pod
   memory. Validated against Kibana 9.5.5 with security on: SLOs compute (bill pay: violated at 84.7 %), the burn-rate
   rule fires, all four ML jobs open and process data, re-runs are clean.
4. Still not built: Synthetics monitors (the app is not reachable from Elastic's hosted locations while ports 80/443
   stay closed; simulated synthetic runs stand in), Cases with the ServiceNow connector, Workflows with approval, and
   Agent Builder. These are configured in Kibana's own apps.
