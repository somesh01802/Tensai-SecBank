import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Calendar, Loader2, Plus, Trash2, TrendingUp, Zap } from "lucide-react"
import toast from "react-hot-toast"

import { investmentsApi } from "@/api/investments"
import { accountsApi } from "@/api/accounts"
import { autopayApi, rewardsApi } from "@/api/v2"
import { apiErrorMessage } from "@/api/client"
import { EmptyState } from "@/components/EmptyState"
import { formatCurrency, formatDate } from "@/lib/utils"
import { cn } from "@/lib/utils"
import type { InvestmentType } from "@/types/api"

const TYPES: { value: InvestmentType; label: string }[] = [
  { value: "MUTUAL_FUND", label: "Mutual fund" },
  { value: "LIFE_INSURANCE", label: "Life insurance" },
  { value: "FIXED_DEPOSIT", label: "Fixed deposit" },
  { value: "STOCKS", label: "Stocks" },
  { value: "RECURRING_DEPOSIT", label: "Recurring deposit" }
]

export function InvestmentsPage() {
  useEffect(() => {
    rewardsApi.event("page.visited.investments").catch(() => {})
    rewardsApi.event("page.visited.investments2").catch(() => {})
  }, [])

  const queryClient = useQueryClient()
  const listQ = useQuery({ queryKey: ["investments"], queryFn: investmentsApi.list })
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list })
  const autopayQ = useQuery({ queryKey: ["autopay"], queryFn: autopayApi.list })

  const [type, setType] = useState<InvestmentType>("MUTUAL_FUND")
  const [name, setName] = useState("")
  const [invested, setInvested] = useState("")
  const [current, setCurrent] = useState("")
  const [monthly, setMonthly] = useState("")

  const [autopayFor, setAutopayFor] = useState<string | null>(null)
  const [apForm, setApForm] = useState({ sourceAccountId: "", amount: "", frequency: "MONTHLY", nextRunAt: new Date().toISOString().slice(0, 16) })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["investments"] })
    queryClient.invalidateQueries({ queryKey: ["autopay"] })
    queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
    queryClient.invalidateQueries({ queryKey: ["accounts"] })
  }

  const create = useMutation({
    mutationFn: investmentsApi.create,
    onSuccess: (i) => {
      toast.success("Investment added")
      rewardsApi.event("investment.added").catch(() => {})
      rewardsApi.event(`investment.type.${i.type}`).catch(() => {})
      setName(""); setInvested(""); setCurrent(""); setMonthly("")
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not add"))
  })
  const remove = useMutation({ mutationFn: investmentsApi.remove, onSuccess: () => { toast.success("Removed"); invalidate() } })
  const enableAp = useMutation({
    mutationFn: autopayApi.create,
    onSuccess: () => { toast.success("AutoPay enabled"); setAutopayFor(null); invalidate() },
    onError: (err) => toast.error(apiErrorMessage(err, "Failed"))
  })
  const toggleAp = useMutation({ mutationFn: autopayApi.toggle, onSuccess: invalidate })
  const removeAp = useMutation({ mutationFn: autopayApi.remove, onSuccess: invalidate })

  const totalInvested = (listQ.data ?? []).reduce((s, i) => s + i.investedAmount, 0)
  const totalCurrent = (listQ.data ?? []).reduce((s, i) => s + i.currentValue, 0)
  const totalReturn = totalCurrent - totalInvested
  const returnPct = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0

  const autopayFor_ = autopayQ.data ?? []
  const autopayByInv = new Map(autopayFor_.map((a) => [a.investmentId, a]))

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Portfolio</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Investments</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatBlock label="Total invested" value={formatCurrency(totalInvested)} />
        <StatBlock label="Current value" value={formatCurrency(totalCurrent)} accent="brand" />
        <StatBlock label="Overall return" value={`${totalReturn >= 0 ? "+" : ""}${formatCurrency(totalReturn)}`}
          hint={`${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`}
          accent={totalReturn >= 0 ? "emerald" : "rose"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {listQ.isLoading ? (
            <div className="card p-5">{[0,1,2].map((i) => <div key={i} className="skeleton mb-2 h-14" />)}</div>
          ) : (listQ.data?.length ?? 0) === 0 ? (
            <EmptyState icon={<TrendingUp className="h-6 w-6" />} title="No investments yet" />
          ) : (
            <div className="card divide-y divide-slate-100 dark:divide-slate-800">
              {listQ.data!.map((i) => {
                const ap = autopayByInv.get(i.id)
                return (
                  <div key={i.id} className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-50 text-xs font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                        {i.type.split("_").map((s) => s[0]).join("").slice(0,2)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold">{i.name}</div>
                        <div className="text-xs text-slate-500">
                          {i.frequencyLabel || (i.monthlyContribution ? `${i.monthlyContribution} / month` : "—")}
                          {ap && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">AutoPay {ap.enabled ? "ON" : "OFF"}</span>}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{formatCurrency(i.currentValue)}</div>
                        {i.returnPct != null && (
                          <div className={cn("text-xs font-semibold", i.returnPct >= 0 ? "text-emerald-600" : "text-rose-600")}>
                            {i.returnPct >= 0 ? "↑" : "↓"} {Math.abs(i.returnPct).toFixed(2)}%
                          </div>
                        )}
                      </div>
                      {ap ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => toggleAp.mutate(ap.id)} className="text-[11px] font-semibold text-brand-600 hover:underline">
                            {ap.enabled ? "Pause" : "Resume"}
                          </button>
                          <button onClick={() => removeAp.mutate(ap.id)} className="btn-ghost !p-2 text-rose-500"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setAutopayFor(autopayFor === i.id ? null : i.id)}
                          className="rounded-lg border border-brand-200 bg-brand-50 px-2 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-100 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300"
                        >
                          <Zap className="mr-1 inline h-3 w-3" /> Set up AutoPay
                        </button>
                      )}
                      <button onClick={() => remove.mutate(i.id)} className="btn-ghost !p-2 text-rose-500"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {autopayFor === i.id && (
                      <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50/40 p-3 dark:border-brand-500/20 dark:bg-brand-500/5">
                        <div className="grid gap-3 md:grid-cols-4">
                          <div className="md:col-span-2">
                            <label className="label">Source account</label>
                            <select className="input" value={apForm.sourceAccountId} onChange={(e) => setApForm({ ...apForm, sourceAccountId: e.target.value })}>
                              <option value="">Select…</option>
                              {(accountsQ.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.accountNumber || a.id.slice(0,8)+"…"} · {formatCurrency(a.balance, a.currency)}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="label">Amount</label>
                            <input className="input" inputMode="decimal" value={apForm.amount} onChange={(e) => setApForm({ ...apForm, amount: e.target.value })} />
                          </div>
                          <div>
                            <label className="label">Frequency</label>
                            <select className="input" value={apForm.frequency} onChange={(e) => setApForm({ ...apForm, frequency: e.target.value })}>
                              {["DAILY","WEEKLY","MONTHLY","QUARTERLY","YEARLY"].map((f) => <option key={f} value={f}>{f}</option>)}
                            </select>
                          </div>
                          <div className="md:col-span-3">
                            <label className="label">Next run at</label>
                            <input type="datetime-local" className="input" value={apForm.nextRunAt} onChange={(e) => setApForm({ ...apForm, nextRunAt: e.target.value })} />
                          </div>
                          <button
                            className="btn-primary md:col-span-1 md:self-end"
                            onClick={() => {
                              if (!apForm.sourceAccountId || !apForm.amount) { toast.error("Fill all fields"); return }
                              enableAp.mutate({
                                investmentId: i.id,
                                sourceAccountId: apForm.sourceAccountId,
                                amount: Number(apForm.amount),
                                frequency: apForm.frequency as any,
                                nextRunAt: new Date(apForm.nextRunAt).toISOString()
                              })
                            }}
                            disabled={enableAp.isPending}
                          >
                            {enableAp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                            Enable
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <form className="card p-5" onSubmit={(e) => { e.preventDefault(); if (!name || !invested) return; create.mutate({ type, name, investedAmount: Number(invested), currentValue: current ? Number(current) : Number(invested), monthlyContribution: monthly ? Number(monthly) : undefined }) }}>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Add investment</div>
          <div className="mt-4 space-y-3">
            <div><label className="label">Type</label><select className="input" value={type} onChange={(e) => setType(e.target.value as InvestmentType)}>{TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
            <div><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <div><label className="label">Invested amount</label><input className="input" inputMode="decimal" value={invested} onChange={(e) => setInvested(e.target.value)} required /></div>
            <div><label className="label">Current value (optional)</label><input className="input" inputMode="decimal" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
            <div><label className="label">Monthly (optional)</label><input className="input" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></div>
            <button className="btn-primary w-full" disabled={create.isPending}>{create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Add</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function StatBlock({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "brand" | "emerald" | "rose" }) {
  const color = accent === "emerald" ? "text-emerald-600" : accent === "rose" ? "text-rose-600" : accent === "brand" ? "text-brand-600" : "text-slate-900 dark:text-slate-100"
  return (
    <div className="card p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">{label}</div>
      <div className={"mt-1 text-2xl font-bold " + color}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}
