import { useMemo, useState, useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts"
import { BarChart3, TrendingUp } from "lucide-react"

import { accountsApi } from "@/api/accounts"
import { transactionsApi } from "@/api/transactions"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { formatCurrency, shortId } from "@/lib/utils"
import { useThemeStore } from "@/stores/themeStore"

const CHART_COLORS = {
  balance: "#3a63ff",
  in: "#10b981",
  out: "#f43f5e",
  pending: "#f59e0b",
  reversed: "#94a3b8"
}

export function AnalyticsPage() {
  const theme = useThemeStore((s) => s.theme)
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list })
  const txQ = useQuery({
    queryKey: ["transactions"],
    queryFn: async () => (await transactionsApi.list()).transactions
  })

  const [accountId, setAccountId] = useState<string>("")

  useEffect(() => {
    if (!accountId && accountsQ.data?.length) {
      setAccountId(accountsQ.data[0].id)
    }
  }, [accountId, accountsQ.data])

  const ledgerQ = useQuery({
    queryKey: ["ledger", accountId],
    queryFn: () => accountsApi.ledger(accountId),
    enabled: Boolean(accountId)
  })

  const balanceSeries = useMemo(() => {
    const entries = ledgerQ.data ?? []
    let running = 0
    return entries.map((e) => {
      running += e.type === "CREDIT" ? e.amount : -e.amount
      const tx = typeof e.transaction === "object" ? e.transaction : null
      return {
        date: tx?.createdAt ? new Date(tx.createdAt).toLocaleDateString("en-IN") : "",
        balance: running,
        amount: e.amount,
        type: e.type
      }
    })
  }, [ledgerQ.data])

  const inOutByDay = useMemo(() => {
    const buckets: Record<string, { day: string; in: number; out: number }> = {}
    ;(txQ.data ?? [])
      .filter((t) => t.status === "COMPLETED")
      .forEach((t) => {
        const day = new Date(t.createdAt).toLocaleDateString("en-IN", {
          month: "short",
          day: "numeric"
        })
        if (!buckets[day]) buckets[day] = { day, in: 0, out: 0 }
        if (t.direction === "IN") buckets[day].in += t.amount
        else buckets[day].out += t.amount
      })
    return Object.values(buckets).slice(-14)
  }, [txQ.data])

  const statusMix = useMemo(() => {
    const counts: Record<string, number> = {}
    ;(txQ.data ?? []).forEach((t) => {
      counts[t.status] = (counts[t.status] || 0) + 1
    })
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [txQ.data])

  const totalIn = inOutByDay.reduce((s, d) => s + d.in, 0)
  const totalOut = inOutByDay.reduce((s, d) => s + d.out, 0)

  const gridColor = theme === "dark" ? "#1e293b" : "#e2e8f0"
  const axisColor = theme === "dark" ? "#64748b" : "#94a3b8"

  if (!accountsQ.isLoading && (accountsQ.data?.length ?? 0) === 0) {
    return (
      <div className="space-y-6">
        <Title />
        <EmptyState
          icon={<BarChart3 className="h-6 w-6" />}
          title="Nothing to chart yet"
          description="Open an account and make transfers to see analytics."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Title />

      {/* Stat tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label="Money in (14d)"
          value={formatCurrency(totalIn)}
          icon={<TrendingUp className="h-4 w-4" />}
          accent="emerald"
        />
        <StatTile
          label="Money out (14d)"
          value={formatCurrency(totalOut)}
          icon={<TrendingUp className="h-4 w-4 rotate-180" />}
          accent="rose"
        />
        <StatTile
          label="Net (14d)"
          value={formatCurrency(totalIn - totalOut)}
          icon={<BarChart3 className="h-4 w-4" />}
          accent="brand"
        />
      </div>

      {/* Balance over time */}
      <div className="card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Balance over time
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Running balance derived from ledger entries.
            </p>
          </div>
          <select
            className="input !w-auto"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accountsQ.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {shortId(a.id, 8, 6)}
              </option>
            ))}
          </select>
        </div>

        <div className="h-72">
          {ledgerQ.isLoading ? (
            <div className="skeleton h-full w-full" />
          ) : balanceSeries.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-slate-500">
              No ledger entries for this account yet.
            </div>
          ) : (
            <ResponsiveContainer>
              <AreaChart data={balanceSeries}>
                <defs>
                  <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.balance} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={CHART_COLORS.balance} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="date" stroke={axisColor} fontSize={11} />
                <YAxis stroke={axisColor} fontSize={11} width={70} />
                <Tooltip
                  contentStyle={{
                    background: theme === "dark" ? "#0f172a" : "#fff",
                    border: `1px solid ${gridColor}`,
                    borderRadius: 12,
                    fontSize: 12
                  }}
                  formatter={(v: number) => formatCurrency(v)}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke={CHART_COLORS.balance}
                  strokeWidth={2}
                  fill="url(#balanceGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Bottom row: bars + pie */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Money in vs out
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">Completed transfers, last 14 days.</p>
          </div>
          <div className="h-64">
            {txQ.isLoading ? (
              <div className="skeleton h-full w-full" />
            ) : inOutByDay.length === 0 ? (
              <div className="grid h-full place-items-center text-sm text-slate-500">
                No completed transfers yet.
              </div>
            ) : (
              <ResponsiveContainer>
                <BarChart data={inOutByDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                  <XAxis dataKey="day" stroke={axisColor} fontSize={11} />
                  <YAxis stroke={axisColor} fontSize={11} width={60} />
                  <Tooltip
                    contentStyle={{
                      background: theme === "dark" ? "#0f172a" : "#fff",
                      border: `1px solid ${gridColor}`,
                      borderRadius: 12,
                      fontSize: 12
                    }}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="in" fill={CHART_COLORS.in} radius={[6, 6, 0, 0]} name="Money in" />
                  <Bar dataKey="out" fill={CHART_COLORS.out} radius={[6, 6, 0, 0]} name="Money out" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card p-5">
          <div className="mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Transaction mix
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">By status.</p>
          </div>
          <div className="h-64">
            {statusMix.length === 0 ? (
              <div className="grid h-full place-items-center text-sm text-slate-500">
                No transactions yet.
              </div>
            ) : (
              <ResponsiveContainer>
                <PieChart>
                  <Tooltip
                    contentStyle={{
                      background: theme === "dark" ? "#0f172a" : "#fff",
                      border: `1px solid ${gridColor}`,
                      borderRadius: 12,
                      fontSize: 12
                    }}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Pie
                    data={statusMix}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={90}
                    paddingAngle={3}
                  >
                    {statusMix.map((s) => (
                      <Cell
                        key={s.name}
                        fill={
                          s.name === "COMPLETED"
                            ? CHART_COLORS.in
                            : s.name === "PENDING"
                            ? CHART_COLORS.pending
                            : s.name === "FAILED"
                            ? CHART_COLORS.out
                            : CHART_COLORS.reversed
                        }
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Title() {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
        Insights
      </div>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
        Analytics
      </h1>
      <p className="mt-1 text-sm text-slate-500">Charts derived from ledger and transactions.</p>
    </div>
  )
}
