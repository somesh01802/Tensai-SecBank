import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts"
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  ChevronDown,
  CreditCard,
  DollarSign,
  Loader2,
  Plus,
  Snowflake,
  TrendingUp,
  Wallet
} from "lucide-react"
import toast from "react-hot-toast"

import { Eye, EyeOff, X } from "lucide-react"

import { dashboardApi } from "@/api/dashboard"
import { billsApi } from "@/api/bills"
import { transactionsApi } from "@/api/transactions"
import { statisticsApi, rewardsApi } from "@/api/v2"
import { newIdempotencyKey } from "@/lib/utils"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"
import { useThemeStore } from "@/stores/themeStore"
import { BillerIcon } from "@/components/dashboard/BillerIcon"
import { formatCurrency, shortId } from "@/lib/utils"
import { cn } from "@/lib/utils"
import type { DashboardSummary } from "@/types/api"

export function DashboardPage() {
  const summaryQ = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: dashboardApi.summary
  })

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      {/* MIDDLE COLUMN */}
      <div className="space-y-6">
        <BalanceCard summary={summaryQ.data} loading={summaryQ.isLoading} />

        <div className="grid gap-6 md:grid-cols-2">
          <InvestmentsCard summary={summaryQ.data} loading={summaryQ.isLoading} />
          <ExpenditureCard summary={summaryQ.data} loading={summaryQ.isLoading} />
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <StatisticsCard summary={summaryQ.data} loading={summaryQ.isLoading} />
          <CardsCard summary={summaryQ.data} loading={summaryQ.isLoading} />
        </div>
      </div>

      {/* RIGHT COLUMN */}
      <div className="space-y-6">
        <QuickTransferCard summary={summaryQ.data} />
        <RecentTransactionsCard summary={summaryQ.data} loading={summaryQ.isLoading} />
        <BillsCard summary={summaryQ.data} loading={summaryQ.isLoading} />
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                           BALANCE  +  ACTIONS                          */
/* --------------------------------------------------------------------- */

function BalanceCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const total = summary?.totalBalance ?? 0
  return (
    <div className="card p-6 sm:p-7">
      <div className="flex flex-wrap items-center gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-slate-400">
            Account balance:
            <button
              onClick={() => {
                setRevealed((v) => {
                  if (!v) rewardsApi.event("ui.balance.revealed").catch(() => {})
                  return !v
                })
              }}
              className="grid h-6 w-6 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              title={revealed ? "Hide balance" : "Reveal balance"}
            >
              {revealed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
          </div>
          {loading ? (
            <div className="skeleton mt-2 h-10 w-56" />
          ) : (
            <div className="mt-1 text-4xl font-extrabold tracking-tight text-slate-900 dark:text-slate-50">
              {revealed ? `Rs. ${formatIndianNumber(total)}` : "Rs. •••••••"}
            </div>
          )}
          {summary?.primaryAccount && (
            <div className="mt-1.5 font-mono text-[11px] text-slate-400">
              Primary · {summary.primaryAccount.accountNumber || shortId(summary.primaryAccount.id, 10, 4)}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/app/transfer"
            className="inline-flex items-center gap-2 rounded-full border border-brand-300 bg-white px-5 py-2.5 text-sm font-semibold text-brand-700 shadow-sm hover:bg-brand-50 dark:border-brand-500/40 dark:bg-slate-900 dark:text-brand-300 dark:hover:bg-brand-500/10"
          >
            <ArrowUpRight className="h-4 w-4" /> Send money
          </Link>
          <button
            onClick={() => setReceiveOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-brand-300 bg-white px-5 py-2.5 text-sm font-semibold text-brand-700 shadow-sm hover:bg-brand-50 dark:border-brand-500/40 dark:bg-slate-900 dark:text-brand-300 dark:hover:bg-brand-500/10"
          >
            <ArrowDownLeft className="h-4 w-4" /> Receive money
          </button>
        </div>
      </div>
      {receiveOpen && (
        <ReceiveMoneyModal
          onClose={() => setReceiveOpen(false)}
          primaryAccountNumber={summary?.primaryAccount?.accountNumber || null}
        />
      )}
    </div>
  )
}

function ReceiveMoneyModal({
  onClose,
  primaryAccountNumber
}: {
  onClose: () => void
  primaryAccountNumber: string | null
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<"FORM" | "CONFIRM">("FORM")
  const [amount, setAmount] = useState("")
  const [remarks, setRemarks] = useState("")
  const [sourceInfo, setSourceInfo] = useState("")
  const [idempotencyKey] = useState(() => newIdempotencyKey())

  const receive = useMutation({
    mutationFn: () => transactionsApi.receive({
      amount: Number(amount),
      remarks: remarks || undefined,
      sourceInfo: sourceInfo || undefined,
      idempotencyKey
    }),
    onSuccess: (tx) => {
      toast.success(`Rs. ${tx.amount.toFixed(2)} credited to your primary account`)
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
      queryClient.invalidateQueries({ queryKey: ["accounts"] })
      queryClient.invalidateQueries({ queryKey: ["transactions"] })
      onClose()
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || "Deposit failed")
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <div>
            <div className="text-sm font-bold">Receive money</div>
            <div className="text-[11px] text-slate-500">
              Demo deposit into your primary account · Tensai SecBank
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost !p-2"><X className="h-4 w-4" /></button>
        </div>

        {step === "FORM" ? (
          <form
            onSubmit={(e) => { e.preventDefault(); if (!Number(amount)) { toast.error("Enter an amount"); return } setStep("CONFIRM") }}
            className="space-y-4 p-5"
          >
            <div>
              <label className="label">Amount</label>
              <div className="relative">
                <span className="absolute inset-y-0 left-4 flex items-center text-slate-400">₹</span>
                <input
                  className="input pl-8 text-lg font-semibold"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                  autoFocus
                />
              </div>
            </div>
            <div>
              <label className="label">Source (optional)</label>
              <input className="input" placeholder="e.g. Employer, Refund" value={sourceInfo} onChange={(e) => setSourceInfo(e.target.value)} />
            </div>
            <div>
              <label className="label">Remarks (optional)</label>
              <input className="input" placeholder="Add a note" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/40">
              Destination: <span className="font-mono text-slate-700 dark:text-slate-200">{primaryAccountNumber || "Primary Account"}</span>
            </div>
            <button className="btn-primary w-full" type="submit">Review</button>
          </form>
        ) : (
          <div className="space-y-4 p-5">
            <div className="rounded-xl bg-emerald-50 p-4 dark:bg-emerald-500/10">
              <div className="text-xs font-semibold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Confirm deposit</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-black text-emerald-700 dark:text-emerald-300">₹ {Number(amount).toFixed(2)}</span>
              </div>
              <div className="mt-2 text-xs text-emerald-800 dark:text-emerald-200">
                To {primaryAccountNumber || "your primary account"}
              </div>
              {sourceInfo && <div className="mt-1 text-xs text-emerald-800 dark:text-emerald-200">From {sourceInfo}</div>}
              {remarks && <div className="mt-1 text-xs italic text-emerald-800 dark:text-emerald-200">"{remarks}"</div>}
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setStep("FORM")}>Back</button>
              <button className="btn-primary flex-[2]" onClick={() => receive.mutate()} disabled={receive.isPending}>
                {receive.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Credit account
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                              INVESTMENTS                                */
/* --------------------------------------------------------------------- */

const INVEST_INITIALS: Record<string, string> = {
  MUTUAL_FUND: "MF",
  LIFE_INSURANCE: "LI",
  FIXED_DEPOSIT: "FD",
  STOCKS: "S",
  RECURRING_DEPOSIT: "RD"
}

function InvestmentsCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            <DollarSign className="h-3.5 w-3.5" />
          </span>
          Investments
        </div>
        <Link to="/app/investments" className="text-xs font-semibold text-slate-500 hover:text-brand-600">
          See all
        </Link>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}
        </div>
      ) : (summary?.investments.length ?? 0) === 0 ? (
        <div className="rounded-xl bg-slate-50 py-6 text-center text-xs text-slate-500 dark:bg-slate-800/50">
          No investments yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {summary!.investments.slice(0, 4).map((i) => (
            <li
              key={i.id}
              className="flex items-center gap-3 rounded-xl bg-orange-50/60 px-3 py-2.5 dark:bg-orange-500/5"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-[11px] font-bold text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-100">
                {INVEST_INITIALS[i.type] || i.type[0]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {i.name}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {i.frequencyLabel ||
                    (i.monthlyContribution ? `${i.monthlyContribution} / month` : "—")}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold">
                  Rs. {formatIndianNumber(i.currentValue)}
                </div>
                {i.returnPct != null && (
                  <div className="mt-0.5 text-[11px] font-semibold text-emerald-600">
                    ↑ {i.returnPct.toFixed(2)} %
                  </div>
                )}
                {i.type === "LIFE_INSURANCE" && i.returnPct == null && (
                  <div className="mt-0.5 text-[11px] text-slate-500">Per year</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                          EXPENDITURE DONUT                              */
/* --------------------------------------------------------------------- */

const EXP_COLORS = ["#fb923c", "#38bdf8", "#a78bfa", "#f472b6", "#facc15", "#4ade80"]

function ExpenditureCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  const theme = useThemeStore((s) => s.theme)
  const data = useMemo(() => {
    const rows = summary?.expenditureByCategory ?? []
    // If everything is 'Other', bucket into some demo categories for the donut
    if (rows.length <= 1 && (rows[0]?.total ?? 0) > 0) {
      const t = rows[0].total
      return [
        { name: "Bills", value: Math.round(t * 0.42) },
        { name: "UPI", value: Math.round(t * 0.24) },
        { name: "EMI", value: Math.round(t * 0.20) },
        { name: "Investments", value: Math.round(t * 0.14) }
      ]
    }
    return rows.map((r) => ({ name: r.category, value: r.total }))
  }, [summary])

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
          <TrendingUp className="h-3.5 w-3.5" />
        </span>
        Expenditure
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="h-52">
          {loading ? (
            <div className="skeleton h-full w-full" />
          ) : data.length === 0 ? (
            <div className="grid h-full place-items-center text-xs text-slate-500">
              No spend yet
            </div>
          ) : (
            <ResponsiveContainer>
              <PieChart>
                <Tooltip
                  contentStyle={{
                    background: theme === "dark" ? "#0f172a" : "#fff",
                    border: "1px solid rgba(148,163,184,.3)",
                    borderRadius: 12,
                    fontSize: 12
                  }}
                  formatter={(v: number) => `Rs. ${formatIndianNumber(v)}`}
                />
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={52}
                  outerRadius={82}
                  paddingAngle={3}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={EXP_COLORS[i % EXP_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs sm:flex-col">
          {data.map((d, i) => (
            <div key={d.name} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: EXP_COLORS[i % EXP_COLORS.length] }}
              />
              <span className="text-slate-600 dark:text-slate-400">{d.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                              STATISTICS                                 */
/* --------------------------------------------------------------------- */

function StatisticsCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  const theme = useThemeStore((s) => s.theme)
  const [range, setRange] = useState<"1D" | "1W" | "1M" | "1Y">("1M")

  const statsQ = useQuery({
    queryKey: ["statistics", range],
    queryFn: () => statisticsApi.get(range)
  })

  useEffect(() => {
    if (range === "1Y") rewardsApi.event("ui.statistics.1y").catch(() => {})
  }, [range])

  const data = useMemo(() => {
    const points = statsQ.data?.points ?? []
    if (points.length >= 2) {
      return points.map((p) => ({
        day: new Date(p.ts).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          ...(range === "1D" ? { hour: "numeric" } : {})
        }),
        balance: p.balance
      }))
    }
    return points.map((p) => ({
      day: new Date(p.ts).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
      balance: p.balance
    }))
  }, [statsQ.data, range])

  const rangeLabel = useMemo(() => {
    const now = new Date()
    const days = { "1D": 1, "1W": 7, "1M": 30, "1Y": 365 }[range]
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
    return `${fmt(start)} – ${fmt(now)}`
  }, [range])

  const grid = theme === "dark" ? "#1e293b" : "#e2e8f0"
  const axis = theme === "dark" ? "#64748b" : "#94a3b8"

  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Statistics
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-full bg-slate-100 p-0.5 dark:bg-slate-800">
            {(["1D","1W","1M","1Y"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                  range === r ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100" : "text-slate-500"
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <span className="hidden text-[11px] font-medium text-slate-500 sm:inline">
            <Calendar className="mr-1 inline h-3 w-3" />
            {rangeLabel}
          </span>
        </div>
      </div>
      <div className="h-52">
        {loading || statsQ.isLoading ? (
          <div className="skeleton h-full w-full" />
        ) : data.length === 0 ? (
          <div className="grid h-full place-items-center text-xs text-slate-500">
            No data in this range yet.
          </div>
        ) : (
          <ResponsiveContainer>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="statGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3a63ff" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#3a63ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="day"
                stroke={axis}
                fontSize={10}
                tickLine={false}
                axisLine={{ stroke: grid }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke={axis}
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: theme === "dark" ? "#0f172a" : "#fff",
                  border: `1px solid ${grid}`,
                  borderRadius: 12,
                  fontSize: 12
                }}
                formatter={(v: number) => `Rs. ${formatIndianNumber(v)}`}
              />
              <Area
                type="monotone"
                dataKey="balance"
                stroke="#3a63ff"
                strokeWidth={2.5}
                fill="url(#statGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                                CARDS                                    */
/* --------------------------------------------------------------------- */

function CardsCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  const navigate = useNavigate()
  const card = summary?.cards[0]
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
            <CreditCard className="h-3.5 w-3.5" />
          </span>
          Cards
        </div>
      </div>

      {loading ? (
        <div className="skeleton h-40 w-full" />
      ) : !card ? (
        <div className="rounded-xl bg-slate-50 py-6 text-center text-xs text-slate-500 dark:bg-slate-800/50">
          No cards yet
        </div>
      ) : (
        <div className="relative mx-auto h-44 max-w-xs">
          <div
            className="absolute inset-0 rounded-2xl p-4 shadow-lg"
            style={{
              background: card.isFrozen
                ? "linear-gradient(135deg,#94a3b8,#475569)"
                : "linear-gradient(135deg,#fbbf24,#fb7185)"
            }}
          >
            <div className="flex items-start justify-between text-white">
              <div className="text-[10px] font-semibold uppercase tracking-widest">
                {card.type === "CREDIT" ? "Credit Card" : "Debit Card"}
              </div>
              <div className="text-lg font-black italic tracking-wider">
                <span className="text-red-500">●</span>
                <span className="-ml-2 text-amber-400">●</span>
              </div>
            </div>
            <div className="mt-9 font-mono text-lg tracking-widest text-white">
              1234 5678 9101 {card.lastFour}
            </div>
            <div className="mt-3 flex items-end justify-between text-white">
              <div className="text-sm font-semibold">{card.holderName}</div>
              <div className="text-xs font-semibold opacity-90">
                {String(card.expiryMonth).padStart(2, "0")}/
                {String(card.expiryYear).padStart(2, "0")}
              </div>
            </div>
            {card.isFrozen && (
              <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                <Snowflake className="h-3 w-3" /> Frozen
              </div>
            )}
          </div>
          {/* Stack hint — subtle card behind */}
          <div
            className="absolute -bottom-1 left-3 right-3 -z-10 h-3 rounded-2xl opacity-40"
            style={{ background: "linear-gradient(135deg,#fbbf24,#fb7185)" }}
          />
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => navigate("/app/cards")}
          className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-600 hover:border-brand-400 hover:text-brand-600 dark:border-slate-800 dark:text-slate-300"
          title="Apply for a new card"
        >
          <Plus className="h-4 w-4" />
        </button>
        <Link
          to="/app/cards"
          className="flex-1 rounded-lg border border-slate-200 py-2 text-center text-sm font-semibold text-slate-700 hover:border-brand-400 hover:text-brand-600 dark:border-slate-800 dark:text-slate-200"
        >
          Manage cards
        </Link>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                        QUICK TRANSFER (right col)                       */
/* --------------------------------------------------------------------- */

function QuickTransferCard({ summary }: { summary?: DashboardSummary }) {
  const navigate = useNavigate()
  const items = (summary?.quickTransfer ?? []).slice(0, 4)
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold">Quick transfer</div>
        <Link to="/app/beneficiaries" className="text-xs font-semibold text-slate-500 hover:text-brand-600">
          See all
        </Link>
      </div>
      <div className="flex items-center gap-3">
        {items.map((b) => (
          <button
            key={b.id}
            onClick={() => navigate("/app/transfer")}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white shadow-sm ring-2 ring-white transition hover:scale-105 dark:ring-slate-900"
            title={b.nickname}
          >
            {initials(b.nickname || b.beneficiaryOwnerName)}
          </button>
        ))}
        {Array.from({ length: Math.max(0, 4 - items.length) }).map((_, i) => (
          <div
            key={`ph-${i}`}
            className="h-11 w-11 shrink-0 rounded-full border border-dashed border-slate-300 dark:border-slate-700"
          />
        ))}
        <Link
          to="/app/beneficiaries"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-slate-300 bg-white text-slate-500 hover:border-brand-400 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          title="Add beneficiary"
        >
          <Plus className="h-4 w-4" />
        </Link>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                        RECENT TRANSACTIONS                              */
/* --------------------------------------------------------------------- */

function RecentTransactionsCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  const txs = (summary?.recentTransactions ?? []).slice(0, 5)
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold">Transactions</div>
        <Link to="/app/transactions" className="text-xs font-semibold text-slate-500 hover:text-brand-600">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      ) : txs.length === 0 ? (
        <div className="rounded-xl bg-slate-50 py-4 text-center text-xs text-slate-500 dark:bg-slate-800/50">
          No transactions yet
        </div>
      ) : (
        <ul className="space-y-2">
          {txs.map((t) => {
            const isIn = t.direction === "IN"
            return (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-xl bg-orange-50/50 px-3 py-2.5 dark:bg-orange-500/5"
              >
                <div
                  className={
                    "grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-white " +
                    (isIn ? "bg-emerald-600" : "bg-rose-600")
                  }
                >
                  {isIn ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t.description || (isIn ? "Received" : "Sent")}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {new Date(t.createdAt).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false
                    })}
                  </div>
                </div>
                <div
                  className={
                    "text-sm font-bold " +
                    (isIn ? "text-emerald-600" : "text-slate-900 dark:text-slate-100")
                  }
                >
                  {isIn ? "+ " : "- "}Rs. {formatIndianNumber(t.amount)}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                                 BILLS                                   */
/* --------------------------------------------------------------------- */

function BillsCard({
  summary,
  loading
}: {
  summary?: DashboardSummary
  loading: boolean
}) {
  const queryClient = useQueryClient()
  const [payingId, setPayingId] = useState<string | null>(null)
  const primary = summary?.primaryAccount?.id

  const pay = useMutation({
    mutationFn: async (id: string) => billsApi.pay(id, primary),
    onMutate: (id) => setPayingId(id),
    onSuccess: () => {
      toast.success("Bill paid")
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Payment failed")),
    onSettled: () => setPayingId(null)
  })

  const bills = summary?.bills ?? []
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold">Bills</div>
        <Link to="/app/bills" className="text-xs font-semibold text-slate-500 hover:text-brand-600">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      ) : bills.length === 0 ? (
        <div className="rounded-xl bg-slate-50 py-4 text-center text-xs text-slate-500 dark:bg-slate-800/50">
          All caught up 🎉
        </div>
      ) : (
        <ul className="space-y-2">
          {bills.slice(0, 4).map((b) => (
            <li
              key={b.id}
              className="group flex items-center gap-3 rounded-xl bg-orange-50/50 px-3 py-2.5 dark:bg-orange-500/5"
            >
              <BillerIcon category={b.category} hint={b.iconHint} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{b.billerName}</div>
                <div className="text-[11px] text-slate-500">
                  {b.dueDate
                    ? new Date(b.dueDate).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short"
                      })
                    : "—"}
                </div>
              </div>
              <div className="flex flex-col items-end">
                <div className="text-sm font-bold">Rs. {formatIndianNumber(b.amount)}</div>
                <button
                  onClick={() => pay.mutate(b.id)}
                  disabled={payingId === b.id || !primary}
                  className="mt-0.5 text-[11px] font-semibold text-brand-600 hover:underline disabled:opacity-40"
                  title={primary ? "Pay from primary account" : "Open an account to pay"}
                >
                  {payingId === b.id ? "…" : "Pay"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------- */
/*                                utils                                    */
/* --------------------------------------------------------------------- */

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase()
}

function formatIndianNumber(n: number) {
  // Indian locale grouping (1,23,456.78)
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n)
}
