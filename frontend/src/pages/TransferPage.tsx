import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight, Calendar, CheckCircle2, Loader2, Plus, Send, Trash2, Users
} from "lucide-react"
import toast from "react-hot-toast"

import { accountsApi } from "@/api/accounts"
import { payeesApi, transferV2 } from "@/api/v2"
import { apiErrorMessage } from "@/api/client"
import { EmptyState } from "@/components/EmptyState"
import { formatCurrency, newIdempotencyKey, shortId, formatDate } from "@/lib/utils"
import { cn } from "@/lib/utils"

type Tab = "QUICK" | "ADD_PAYEE" | "MANAGE" | "SCHEDULE"

export function TransferPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>("QUICK")
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list })
  const banksQ = useQuery({ queryKey: ["banks"], queryFn: payeesApi.banks })
  const payeesQ = useQuery({ queryKey: ["payees"], queryFn: payeesApi.list })
  const schedQ = useQuery({ queryKey: ["scheduled-transfers"], queryFn: transferV2.listScheduled })

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["accounts"] })
    queryClient.invalidateQueries({ queryKey: ["payees"] })
    queryClient.invalidateQueries({ queryKey: ["scheduled-transfers"] })
    queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
    queryClient.invalidateQueries({ queryKey: ["transactions"] })
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Money movement</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Transfer</h1>
      </div>

      <div className="card flex flex-wrap items-center gap-1 p-1">
        {[
          { k: "QUICK", l: "Quick Fund Transfer", icon: Send },
          { k: "ADD_PAYEE", l: "Add New Payee", icon: Plus },
          { k: "MANAGE", l: "Manage Payees", icon: Users },
          { k: "SCHEDULE", l: "Schedule Transfer", icon: Calendar }
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as Tab)}
            className={cn(
              "flex-1 min-w-[150px] rounded-lg px-3 py-2 text-sm font-semibold",
              tab === t.k ? "bg-brand-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            )}
          >
            <t.icon className="mr-1.5 inline h-3.5 w-3.5" />
            {t.l}
          </button>
        ))}
      </div>

      {tab === "QUICK" && <QuickTab banks={banksQ.data ?? []} accounts={accountsQ.data ?? []} onDone={invalidateAll} />}
      {tab === "ADD_PAYEE" && <AddPayeeTab banks={banksQ.data ?? []} onDone={invalidateAll} />}
      {tab === "MANAGE" && <ManageTab payees={payeesQ.data ?? []} onDone={invalidateAll} />}
      {tab === "SCHEDULE" && (
        <ScheduleTab
          payees={(payeesQ.data ?? []).filter((p) => p.active)}
          accounts={accountsQ.data ?? []}
          scheduled={schedQ.data ?? []}
          onDone={invalidateAll}
        />
      )}
    </div>
  )
}

/* --------------------------------- Quick --------------------------------- */

function QuickTab({ banks, accounts, onDone }: { banks: string[]; accounts: any[]; onDone: () => void }) {
  const [step, setStep] = useState<"FORM" | "CONFIRM">("FORM")
  const [form, setForm] = useState({
    bankName: banks[0] || "", accountNumber: "", confirmAccountNumber: "", accountHolderName: "",
    amount: "", remarks: "",
    sourceAccountId: accounts[0]?.id || "",
    savePayee: false,
    idempotencyKey: newIdempotencyKey()
  })
  useEffect(() => { if (!form.bankName && banks.length) setForm((f) => ({ ...f, bankName: banks[0] })) }, [banks])
  useEffect(() => { if (!form.sourceAccountId && accounts.length) setForm((f) => ({ ...f, sourceAccountId: accounts[0].id })) }, [accounts])

  const mutation = useMutation({
    mutationFn: () => transferV2.quick({
      ...form,
      amount: Number(form.amount)
    }),
    onSuccess: () => {
      toast.success("Transfer completed")
      setForm({ ...form, accountNumber: "", confirmAccountNumber: "", accountHolderName: "", amount: "", remarks: "", idempotencyKey: newIdempotencyKey() })
      setStep("FORM")
      onDone()
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Transfer failed"))
  })

  function next(e: React.FormEvent) {
    e.preventDefault()
    if (form.accountNumber !== form.confirmAccountNumber) return toast.error("Account numbers do not match")
    if (!Number(form.amount)) return toast.error("Enter a valid amount")
    setStep("CONFIRM")
  }

  if (step === "CONFIRM") {
    return (
      <div className="card mx-auto max-w-xl p-6">
        <div className="text-lg font-bold">Confirm transfer</div>
        <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-900/40">
          <Row l="Bank" v={form.bankName} />
          <Row l="Account number" v={form.accountNumber} mono />
          <Row l="Recipient" v={form.accountHolderName} />
          <Row l="Amount" v={formatCurrency(Number(form.amount))} bold />
          {form.remarks && <Row l="Remarks" v={form.remarks} />}
          <Row l="From" v={accounts.find((a) => a.id === form.sourceAccountId)?.accountNumber || shortId(form.sourceAccountId, 8, 6)} mono />
        </div>
        <div className="mt-6 flex gap-2">
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="btn-primary">
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Transfer
          </button>
          <button onClick={() => setStep("FORM")} className="btn-secondary">Back</button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={next} className="card p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div><label className="label">Bank</label>
          <select className="input" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })}>
            {banks.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div><label className="label">Amount</label>
          <input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, "") })} required />
        </div>
        <div><label className="label">Account number</label>
          <input className="input font-mono" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, "") })} required />
        </div>
        <div><label className="label">Confirm account number</label>
          <input className="input font-mono" value={form.confirmAccountNumber} onChange={(e) => setForm({ ...form, confirmAccountNumber: e.target.value.replace(/\D/g, "") })} required />
        </div>
        <div><label className="label">Account holder name</label>
          <input className="input" value={form.accountHolderName} onChange={(e) => setForm({ ...form, accountHolderName: e.target.value })} required />
        </div>
        <div><label className="label">Source account</label>
          <select className="input" value={form.sourceAccountId} onChange={(e) => setForm({ ...form, sourceAccountId: e.target.value })}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber || shortId(a.id, 8, 6)} · {formatCurrency(a.balance, a.currency)}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Remarks (optional)</label>
          <input className="input" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 md:col-span-2">
          <input type="checkbox" checked={form.savePayee} onChange={(e) => setForm({ ...form, savePayee: e.target.checked })} className="h-4 w-4" />
          <span className="text-sm">Save this recipient as a payee</span>
        </label>
      </div>
      <button className="btn-primary mt-6">
        Review <ArrowRight className="h-4 w-4" />
      </button>
    </form>
  )
}

/* -------------------------------- Add Payee ------------------------------ */

function AddPayeeTab({ banks, onDone }: { banks: string[]; onDone: () => void }) {
  const [form, setForm] = useState({ bankName: banks[0] || "", accountNumber: "", confirmAccountNumber: "", accountHolderName: "", nickname: "" })
  useEffect(() => { if (!form.bankName && banks.length) setForm((f) => ({ ...f, bankName: banks[0] })) }, [banks])

  const create = useMutation({
    mutationFn: () => payeesApi.create(form),
    onSuccess: () => { toast.success("Payee added"); setForm({ bankName: banks[0] || "", accountNumber: "", confirmAccountNumber: "", accountHolderName: "", nickname: "" }); onDone() },
    onError: (err) => toast.error(apiErrorMessage(err, "Failed"))
  })

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (form.accountNumber !== form.confirmAccountNumber) return toast.error("Account numbers do not match"); create.mutate() }} className="card mx-auto max-w-2xl p-6">
      <div className="text-lg font-bold">Add a new payee</div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div><label className="label">Bank</label>
          <select className="input" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })}>
            {banks.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div><label className="label">Nickname</label>
          <input className="input" placeholder="e.g. Mom, Landlord" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} required />
        </div>
        <div><label className="label">Account number</label>
          <input className="input font-mono" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, "") })} required />
        </div>
        <div><label className="label">Confirm account number</label>
          <input className="input font-mono" value={form.confirmAccountNumber} onChange={(e) => setForm({ ...form, confirmAccountNumber: e.target.value.replace(/\D/g, "") })} required />
        </div>
        <div className="md:col-span-2"><label className="label">Account holder name</label>
          <input className="input" value={form.accountHolderName} onChange={(e) => setForm({ ...form, accountHolderName: e.target.value })} required />
        </div>
      </div>
      <button className="btn-primary mt-6" disabled={create.isPending}>
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Save payee
      </button>
    </form>
  )
}

/* -------------------------------- Manage Payees -------------------------- */

function ManageTab({ payees, onDone }: { payees: any[]; onDone: () => void }) {
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: any }) => payeesApi.update(id, patch), onSuccess: onDone })
  const remove = useMutation({ mutationFn: (id: string) => payeesApi.remove(id), onSuccess: () => { toast.success("Payee removed"); onDone() } })
  if (payees.length === 0) return <EmptyState icon={<Users className="h-6 w-6" />} title="No payees yet" description="Add a payee to get started." />
  return (
    <div className="card divide-y divide-slate-100 dark:divide-slate-800">
      {payees.map((p) => (
        <div key={p.id} className="flex items-center gap-3 px-5 py-4">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-50 text-xs font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
            {p.nickname.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{p.nickname}</div>
            <div className="text-xs text-slate-500 font-mono">{p.accountNumber} · {p.bankName}</div>
            <div className="text-[11px] text-slate-400">{p.accountHolderName}</div>
          </div>
          <button
            onClick={() => update.mutate({ id: p.id, patch: { active: !p.active } })}
            className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", p.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}
          >
            {p.active ? "ACTIVE" : "INACTIVE"}
          </button>
          <button onClick={() => remove.mutate(p.id)} className="btn-ghost !p-2 text-rose-500"><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------- Schedule ------------------------------- */

function ScheduleTab({ payees, accounts, scheduled, onDone }: { payees: any[]; accounts: any[]; scheduled: any[]; onDone: () => void }) {
  const [form, setForm] = useState({
    payeeId: payees[0]?.id || "",
    sourceAccountId: accounts[0]?.id || "",
    amount: "", remarks: "",
    date: new Date().toISOString().slice(0, 10),
    time: "09:00",
    frequency: "ONCE"
  })
  useEffect(() => { if (!form.payeeId && payees.length) setForm((f) => ({ ...f, payeeId: payees[0].id })) }, [payees])
  useEffect(() => { if (!form.sourceAccountId && accounts.length) setForm((f) => ({ ...f, sourceAccountId: accounts[0].id })) }, [accounts])

  const create = useMutation({
    mutationFn: () => transferV2.createScheduled({
      payeeId: form.payeeId,
      sourceAccountId: form.sourceAccountId,
      amount: Number(form.amount),
      remarks: form.remarks || undefined,
      frequency: form.frequency as any,
      nextRunAt: new Date(`${form.date}T${form.time}`).toISOString()
    }),
    onSuccess: () => { toast.success("Transfer scheduled"); setForm((f) => ({ ...f, amount: "", remarks: "" })); onDone() },
    onError: (err) => toast.error(apiErrorMessage(err, "Failed"))
  })

  const toggle = useMutation({ mutationFn: (id: string) => transferV2.toggleScheduled(id), onSuccess: onDone })
  const cancel = useMutation({ mutationFn: (id: string) => transferV2.cancelScheduled(id), onSuccess: () => { toast.success("Scheduled transfer cancelled"); onDone() } })

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {scheduled.length === 0 ? (
          <EmptyState icon={<Calendar className="h-6 w-6" />} title="No scheduled transfers" description="Set one up on the right." />
        ) : (
          <div className="card divide-y divide-slate-100 dark:divide-slate-800">
            {scheduled.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-5 py-4">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                  <Calendar className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">To {s.payeeName} · {s.bankName}</div>
                  <div className="text-xs text-slate-500">
                    {formatDate(s.nextRunAt)} · {s.frequency}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold">{formatCurrency(s.amount)}</div>
                  <span className={cn(
                    "text-[10px] font-bold uppercase",
                    s.status === "COMPLETED" ? "text-emerald-600" :
                    s.status === "FAILED" ? "text-rose-600" :
                    s.status === "CANCELLED" ? "text-slate-500" : "text-brand-600"
                  )}>{s.status}</span>
                </div>
                {s.status === "SCHEDULED" && (
                  <>
                    <button onClick={() => toggle.mutate(s.id)} className="text-xs font-semibold text-brand-600 hover:underline">
                      {s.enabled ? "Pause" : "Resume"}
                    </button>
                    <button onClick={() => cancel.mutate(s.id)} className="btn-ghost !p-2 text-rose-500"><Trash2 className="h-4 w-4" /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); if (!form.payeeId || !form.amount) return; create.mutate() }} className="card p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Schedule a transfer</div>
        <div className="mt-4 space-y-3">
          <div><label className="label">Payee</label>
            <select className="input" value={form.payeeId} onChange={(e) => setForm({ ...form, payeeId: e.target.value })}>
              {payees.map((p) => <option key={p.id} value={p.id}>{p.nickname} · {p.bankName}</option>)}
            </select>
          </div>
          <div><label className="label">Amount</label>
            <input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, "") })} required />
          </div>
          <div><label className="label">Remarks</label>
            <input className="input" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label">Date</label>
              <input type="date" className="input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </div>
            <div><label className="label">Time</label>
              <input type="time" className="input" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} required />
            </div>
          </div>
          <div><label className="label">Frequency</label>
            <select className="input" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              {["ONCE","DAILY","WEEKLY","MONTHLY","QUARTERLY","YEARLY"].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div><label className="label">Source account</label>
            <select className="input" value={form.sourceAccountId} onChange={(e) => setForm({ ...form, sourceAccountId: e.target.value })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber || shortId(a.id, 8, 6)} · {formatCurrency(a.balance, a.currency)}</option>)}
            </select>
          </div>
          <button className="btn-primary w-full" disabled={create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
            Schedule
          </button>
        </div>
      </form>
    </div>
  )
}

function Row({ l, v, bold, mono }: { l: string; v: string; bold?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{l}</span>
      <span className={cn(bold && "text-lg font-black", mono && "font-mono text-xs")}>{v}</span>
    </div>
  )
}
