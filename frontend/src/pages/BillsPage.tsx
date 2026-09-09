import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Loader2, Plus, Receipt, RefreshCcw, Trash2, Zap } from "lucide-react"
import toast from "react-hot-toast"

import { billsApi } from "@/api/bills"
import { accountsApi } from "@/api/accounts"
import { recurringBillsApi, rewardsApi } from "@/api/v2"
import { apiErrorMessage } from "@/api/client"
import { EmptyState } from "@/components/EmptyState"
import { BillerIcon } from "@/components/dashboard/BillerIcon"
import { formatCurrency, formatDate } from "@/lib/utils"
import { cn } from "@/lib/utils"

const CATEGORIES = ["PHONE","CREDIT_CARD","EMI","STREAMING","ELECTRICITY","INTERNET","FUEL","WATER","GAS","OTHER"]

type Tab = "ONE_TIME" | "RECURRING"

export function BillsPage() {
  useEffect(() => { rewardsApi.event("page.visited.bills").catch(() => {}) }, [])

  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>("ONE_TIME")

  const billsQ = useQuery({ queryKey: ["bills"], queryFn: billsApi.list })
  const recurringQ = useQuery({ queryKey: ["recurring-bills"], queryFn: recurringBillsApi.list })
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list })

  const primary = useMemo(() => accountsQ.data?.[0]?.id, [accountsQ.data])
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["bills"] })
    queryClient.invalidateQueries({ queryKey: ["recurring-bills"] })
    queryClient.invalidateQueries({ queryKey: ["accounts"] })
    queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Payables</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Bills</h1>
      </div>

      <div className="card flex items-center gap-1 p-1">
        {([{ k: "ONE_TIME", l: "One-time" }, { k: "RECURRING", l: "Recurring" }] as const).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={cn(
              "flex-1 rounded-lg px-3 py-2 text-sm font-semibold",
              tab === t.k ? "bg-brand-600 text-white" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            )}
          >
            {t.l}
          </button>
        ))}
      </div>

      {tab === "ONE_TIME"
        ? <OneTimeBills bills={billsQ.data ?? []} loading={billsQ.isLoading} primary={primary} accounts={accountsQ.data ?? []} onChanged={invalidate} />
        : <RecurringBills list={recurringQ.data ?? []} loading={recurringQ.isLoading} primary={primary} accounts={accountsQ.data ?? []} onChanged={invalidate} />}
    </div>
  )
}

function OneTimeBills({
  bills, loading, primary, accounts, onChanged
}: {
  bills: any[]; loading: boolean; primary: string | undefined; accounts: any[]; onChanged: () => void
}) {
  const [form, setForm] = useState({ billerName: "", category: "OTHER", amount: "", dueDate: "" })

  const create = useMutation({
    mutationFn: billsApi.create,
    onSuccess: () => { toast.success("Bill added"); setForm({ billerName: "", category: "OTHER", amount: "", dueDate: "" }); onChanged() }
  })
  const pay = useMutation({
    mutationFn: (id: string) => billsApi.pay(id, primary),
    onSuccess: () => { toast.success("Bill paid"); onChanged() }
  })
  const remove = useMutation({ mutationFn: billsApi.remove, onSuccess: () => { toast.success("Removed"); onChanged() } })

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {loading ? (
          <div className="card p-5">{[0,1,2].map((i) => <div key={i} className="skeleton mb-2 h-14" />)}</div>
        ) : bills.length === 0 ? (
          <EmptyState icon={<Receipt className="h-6 w-6" />} title="No bills" />
        ) : (
          <div className="card divide-y divide-slate-100 dark:divide-slate-800">
            {bills.map((b) => (
              <div key={b.id} className="flex items-center gap-3 px-5 py-4">
                <BillerIcon category={b.category} hint={b.iconHint} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{b.billerName}</div>
                  <div className="text-xs text-slate-500">
                    {b.dueDate ? `Due ${formatDate(b.dueDate).split(",")[0]}` : "—"} · {b.category}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold">{formatCurrency(b.amount)}</div>
                  {b.status === "PAID" ? (
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
                      <CheckCircle2 className="h-3 w-3" /> Paid
                    </div>
                  ) : (
                    <button onClick={() => pay.mutate(b.id)} disabled={pay.isPending || !primary} className="mt-0.5 text-[11px] font-semibold text-brand-600 hover:underline disabled:opacity-40">
                      {pay.isPending ? "…" : "Pay now"}
                    </button>
                  )}
                </div>
                <button onClick={() => remove.mutate(b.id)} className="btn-ghost !p-2 text-rose-500"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <form className="card p-5" onSubmit={(e) => { e.preventDefault(); if (!form.billerName || !form.amount) return; create.mutate({ ...form, amount: Number(form.amount), dueDate: form.dueDate || undefined }) }}>
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Add bill</div>
        <div className="mt-4 space-y-3">
          <div><label className="label">Biller name</label><input className="input" value={form.billerName} onChange={(e) => setForm({ ...form, billerName: e.target.value })} required /></div>
          <div><label className="label">Category</label><select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          <div><label className="label">Amount</label><input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></div>
          <div><label className="label">Due date</label><input type="date" className="input" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></div>
          <button className="btn-primary w-full" disabled={create.isPending}>{create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Add</button>
        </div>
      </form>
    </div>
  )
}

function RecurringBills({
  list, loading, primary, accounts, onChanged
}: { list: any[]; loading: boolean; primary: string | undefined; accounts: any[]; onChanged: () => void }) {
  const [form, setForm] = useState({
    billerName: "", category: "OTHER", amount: "", autoDetectAmount: false,
    frequency: "MONTHLY", sourceAccountId: primary || "", autopayEnabled: true, nextRunAt: new Date().toISOString().slice(0, 16)
  })

  useEffect(() => { if (primary) setForm((f) => ({ ...f, sourceAccountId: primary })) }, [primary])

  const detect = useMutation({
    mutationFn: recurringBillsApi.autoDetect,
    onSuccess: (r) => { toast.success(`Auto-detected: ${formatCurrency(r.amount)}`); setForm((f) => ({ ...f, amount: String(r.amount) })) }
  })
  const create = useMutation({
    mutationFn: recurringBillsApi.create,
    onSuccess: () => { toast.success("Recurring bill set up"); setForm((f) => ({ ...f, billerName: "", amount: "" })); onChanged() }
  })
  const toggle = useMutation({ mutationFn: recurringBillsApi.toggle, onSuccess: onChanged })
  const remove = useMutation({ mutationFn: recurringBillsApi.remove, onSuccess: onChanged })

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {loading ? (
          <div className="card p-5">{[0,1].map((i) => <div key={i} className="skeleton mb-2 h-14" />)}</div>
        ) : list.length === 0 ? (
          <EmptyState icon={<RefreshCcw className="h-6 w-6" />} title="No recurring bills" />
        ) : (
          <div className="card divide-y divide-slate-100 dark:divide-slate-800">
            {list.map((b) => (
              <div key={b.id} className="flex items-center gap-3 px-5 py-4">
                <BillerIcon category={b.category} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{b.billerName}</div>
                  <div className="text-xs text-slate-500">
                    {b.frequency.toLowerCase()} · next {new Date(b.nextRunAt).toLocaleDateString("en-IN")} · {b.autopayEnabled ? "AutoPay ON" : "Manual"}
                    {b.autoDetectAmount && " · auto-detect"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold">{formatCurrency(b.amount)}</div>
                  <button onClick={() => toggle.mutate(b.id)} className="mt-0.5 text-[11px] font-semibold text-brand-600 hover:underline">
                    {b.enabled ? "Pause" : "Resume"}
                  </button>
                </div>
                <button onClick={() => remove.mutate(b.id)} className="btn-ghost !p-2 text-rose-500"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <form className="card p-5" onSubmit={(e) => {
        e.preventDefault()
        if (!form.billerName || !form.nextRunAt) return
        if (!form.autoDetectAmount && !form.amount) { toast.error("Amount required (or enable auto-detect)"); return }
        create.mutate({
          billerName: form.billerName,
          category: form.category,
          amount: form.autoDetectAmount ? undefined : Number(form.amount),
          autoDetectAmount: form.autoDetectAmount,
          frequency: form.frequency as any,
          sourceAccountId: form.sourceAccountId || undefined,
          autopayEnabled: form.autopayEnabled,
          nextRunAt: new Date(form.nextRunAt).toISOString()
        })
      }}>
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Set up recurring bill</div>
        <div className="mt-4 space-y-3">
          <div><label className="label">Biller name</label><input className="input" value={form.billerName} onChange={(e) => setForm({ ...form, billerName: e.target.value })} required /></div>
          <div><label className="label">Category</label><select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={form.autoDetectAmount} onChange={(e) => setForm({ ...form, autoDetectAmount: e.target.checked })} id="detect" className="h-4 w-4" />
            <label htmlFor="detect" className="text-xs font-medium">Auto-detect amount (demo provider)</label>
          </div>
          {!form.autoDetectAmount ? (
            <div><label className="label">Amount</label>
              <div className="flex gap-2">
                <input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
                <button type="button" className="btn-secondary" onClick={() => detect.mutate({ billerName: form.billerName || "Biller", category: form.category })} disabled={detect.isPending}>
                  {detect.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              Amount will be fetched from the demo bill-provider adapter on each run.
            </div>
          )}
          <div><label className="label">Frequency</label><select className="input" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>{["DAILY","WEEKLY","MONTHLY","QUARTERLY","YEARLY"].map((f) => <option key={f} value={f}>{f}</option>)}</select></div>
          <div><label className="label">Source account</label><select className="input" value={form.sourceAccountId} onChange={(e) => setForm({ ...form, sourceAccountId: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber || a.id.slice(0,8)+"…"} · {formatCurrency(a.balance, a.currency)}</option>)}</select></div>
          <div><label className="label">Next payment date/time</label><input type="datetime-local" className="input" value={form.nextRunAt} onChange={(e) => setForm({ ...form, nextRunAt: e.target.value })} required /></div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={form.autopayEnabled} onChange={(e) => setForm({ ...form, autopayEnabled: e.target.checked })} id="autopay" className="h-4 w-4" />
            <label htmlFor="autopay" className="text-xs font-medium">Enable AutoPay</label>
          </div>
          <button className="btn-primary w-full" disabled={create.isPending}>{create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Create</button>
        </div>
      </form>
    </div>
  )
}
