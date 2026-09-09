import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { ArrowDownLeft, ArrowUpRight, Download, Receipt, Search } from "lucide-react"
import toast from "react-hot-toast"

import { transactionsApi } from "@/api/transactions"
import { EmptyState } from "@/components/EmptyState"
import { TxStatusBadge } from "@/components/StatusBadge"
import { formatCurrency, formatDate, shortId } from "@/lib/utils"
import type { Transaction, TransactionStatus } from "@/types/api"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/authStore"

type StatusFilter = "ALL" | TransactionStatus | "IN" | "OUT"
type RangeKey = "ALL" | "1D" | "1W" | "1M" | "CUSTOM"

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "COMPLETED", label: "Completed" },
  { key: "PENDING", label: "Pending" },
  { key: "FAILED", label: "Failed" },
  { key: "IN", label: "Incoming" },
  { key: "OUT", label: "Outgoing" }
]

function isoStart(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString() }
function isoEnd(d: Date) { const x = new Date(d); x.setHours(23,59,59,999); return x.toISOString() }
function daysAgo(n: number) { return new Date(Date.now() - n * 24 * 60 * 60 * 1000) }

export function TransactionsPage() {
  const [params] = useSearchParams()
  const highlightId = params.get("highlight")
  const initialQuery = params.get("q") ?? ""
  const token = useAuthStore((s) => s.token)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [search, setSearch] = useState(initialQuery)
  const [range, setRange] = useState<RangeKey>("1M")
  const [customFrom, setCustomFrom] = useState(new Date().toISOString().slice(0, 10))
  const [customTo, setCustomTo] = useState(new Date().toISOString().slice(0, 10))

  const { from, to } = useMemo(() => {
    if (range === "ALL") return { from: undefined, to: undefined }
    if (range === "1D") return { from: isoStart(daysAgo(1)), to: isoEnd(new Date()) }
    if (range === "1W") return { from: isoStart(daysAgo(7)), to: isoEnd(new Date()) }
    if (range === "1M") return { from: isoStart(daysAgo(30)), to: isoEnd(new Date()) }
    // CUSTOM
    if (new Date(customFrom) > new Date(customTo)) {
      return { from: isoStart(new Date(customTo)), to: isoEnd(new Date(customFrom)) }
    }
    return { from: isoStart(new Date(customFrom)), to: isoEnd(new Date(customTo)) }
  }, [range, customFrom, customTo])

  const txQ = useQuery({
    queryKey: ["transactions", from, to],
    queryFn: () => transactionsApi.list({ from, to, limit: 1000 })
  })

  const filtered = useMemo(() => {
    const data = txQ.data?.transactions ?? []
    return data
      .filter((t) => {
        if (statusFilter === "ALL") return true
        if (statusFilter === "IN" || statusFilter === "OUT") return t.direction === statusFilter
        return t.status === statusFilter
      })
      .filter((t) => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return (
          t._id.toLowerCase().includes(q) ||
          t.fromAccount.toLowerCase().includes(q) ||
          t.toAccount.toLowerCase().includes(q) ||
          t.idempotencyKey.toLowerCase().includes(q) ||
          (t.description || "").toLowerCase().includes(q) ||
          (t.category || "").toLowerCase().includes(q) ||
          String(t.amount).includes(q)
        )
      })
  }, [txQ.data, statusFilter, search])

  async function downloadCsv() {
    try {
      const res = await fetch(transactionsApi.statementUrl({ from, to }), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: "include"
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => "")
        throw new Error(msg || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const disp = res.headers.get("content-disposition") || ""
      const m = disp.match(/filename="?([^";]+)"?/i)
      a.download = m?.[1] || "tensai-statement.csv"
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success("Statement downloaded")
    } catch (err: any) {
      toast.error("Download failed: " + (err?.message || "unknown error"))
    }
  }

  const rangeLabel = useMemo(() => {
    if (!from && !to) return "All time"
    const fmt = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    return `${from ? fmt(from) : "…"} → ${to ? fmt(to) : "…"}`
  }, [from, to])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-slate-500">History</div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Transactions</h1>
          <p className="mt-1 text-xs text-slate-500">{rangeLabel}</p>
        </div>
        <button className="btn-secondary" onClick={downloadCsv}>
          <Download className="h-4 w-4" />
          Download Statement
        </button>
      </div>

      {/* Range filter */}
      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["1D","1W","1M","ALL","CUSTOM"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold",
                range === r ? "bg-brand-600 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
              )}
            >
              {r === "ALL" ? "All time" : r === "CUSTOM" ? "Custom" : r === "1D" ? "1 Day" : r === "1W" ? "1 Week" : "1 Month"}
            </button>
          ))}

          {range === "CUSTOM" && (
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" className="input !w-auto" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="text-slate-400">→</span>
              <input type="date" className="input !w-auto" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          )}
        </div>

        {/* Search + status filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-10"
              placeholder="Search by description, category, account, ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  statusFilter === f.key
                    ? "bg-slate-800 text-white dark:bg-white dark:text-slate-900"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Totals */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Total transactions</div>
          <div className="mt-1 text-2xl font-bold">{filtered.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Credit</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600">
            {formatCurrency(filtered.filter((t) => t.direction === "IN" && t.status === "COMPLETED").reduce((s, t) => s + t.amount, 0))}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Debit</div>
          <div className="mt-1 text-2xl font-bold text-rose-600">
            {formatCurrency(filtered.filter((t) => t.direction === "OUT" && t.status === "COMPLETED").reduce((s, t) => s + t.amount, 0))}
          </div>
        </div>
      </div>

      {txQ.isLoading ? (
        <div className="card p-5">
          {[0,1,2,3,4].map((i) => <div key={i} className="skeleton mb-3 h-14" />)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Receipt className="h-6 w-6" />} title="No transactions" description="Try widening the date range or clearing filters." />
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:border-slate-800 sm:grid">
            <div className="col-span-1"></div>
            <div className="col-span-4">Counterparty · Description</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-3">Date</div>
            <div className="col-span-2 text-right">Amount</div>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((t) => (
              <TxRow key={t._id} tx={t} highlight={t._id === highlightId} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function TxRow({ tx, highlight }: { tx: Transaction; highlight?: boolean }) {
  const isIn = tx.direction === "IN"
  return (
    <li className={cn("px-5 py-4 transition-colors", highlight && "bg-brand-50/60 dark:bg-brand-500/5")}>
      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-12 sm:gap-4">
        <div className="sm:col-span-1">
          <div className={cn(
            "grid h-10 w-10 place-items-center rounded-xl",
            isIn ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300"
                 : "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300"
          )}>
            {isIn ? <ArrowDownLeft className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
          </div>
        </div>
        <div className="sm:col-span-4">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {tx.description || (isIn ? "Received" : "Sent")}
          </div>
          <div className="mt-0.5 font-mono text-xs text-slate-500">
            {shortId(isIn ? tx.fromAccount : tx.toAccount, 10, 6)}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {tx.category && <span className="mr-2 rounded-full bg-slate-100 px-1.5 py-0.5 font-bold uppercase tracking-widest text-slate-500 dark:bg-slate-800">{tx.category}</span>}
            key {shortId(tx.idempotencyKey, 8, 4)}
          </div>
        </div>
        <div className="sm:col-span-2"><TxStatusBadge status={tx.status} /></div>
        <div className="text-xs text-slate-500 sm:col-span-3">{formatDate(tx.createdAt)}</div>
        <div className="text-right sm:col-span-2">
          <div className={cn("text-sm font-bold",
            isIn ? "text-emerald-600 dark:text-emerald-400" : "text-slate-900 dark:text-slate-100"
          )}>
            {isIn ? "+" : "−"}{formatCurrency(tx.amount)}
          </div>
        </div>
      </div>
    </li>
  )
}
