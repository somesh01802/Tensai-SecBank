import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Briefcase, ChevronRight, CheckCircle2, Globe, LineChart, Loader2,
  PiggyBank, Trash2, Wallet, Copy, X, ArrowLeftRight
} from "lucide-react"
import toast from "react-hot-toast"

import { accountsApi } from "@/api/accounts"
import { accountAppApi, rewardsApi } from "@/api/v2"
import { transactionsApi } from "@/api/transactions"
import { apiErrorMessage, api } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"
import { formatCurrency, formatDate, newIdempotencyKey, shortId } from "@/lib/utils"
import { cn } from "@/lib/utils"
import type { Account } from "@/types/api"

const TYPES = [
  { kind: "SAVINGS" as const, name: "Savings Account", icon: PiggyBank, blurb: "Zero-balance, virtual RuPay, UPI ready" },
  { kind: "SALARY" as const, name: "Salary Account", icon: Wallet, blurb: "Auto-sweep, no-min-balance for salaried" },
  { kind: "NRI" as const, name: "NRI Account", icon: Globe, blurb: "For non-residents (NRE / NRO / FCNR)" },
  { kind: "BUSINESS" as const, name: "Business Account", icon: Briefcase, blurb: "Current account for MSMEs and startups" },
  { kind: "INVESTMENT" as const, name: "Investment Account", icon: LineChart, blurb: "MF/Demat linkage" }
]

const EXTRA_FIELDS: Record<string, Array<{ key: string; label: string; type?: string; placeholder?: string }>> = {
  SAVINGS: [],
  SALARY: [{ key: "employer", label: "Employer name", placeholder: "Acme Corp" }],
  NRI: [{ key: "country", label: "Country of residence", placeholder: "United Kingdom" }, { key: "passport", label: "Passport number" }],
  BUSINESS: [{ key: "businessName", label: "Business name", placeholder: "Widgets LLP" }, { key: "gst", label: "GSTIN (optional)" }],
  INVESTMENT: [{ key: "riskAppetite", label: "Risk appetite (LOW/MED/HIGH)" }]
}

type Tab = "ACCOUNTS" | "OPEN" | "INTERNAL_TRANSFER"

export function ManageAccountPage() {
  useEffect(() => { rewardsApi.event("page.visited.manage_account").catch(() => {}) }, [])

  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list })

  const [tab, setTab] = useState<Tab>("ACCOUNTS")
  const [openingKind, setOpeningKind] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [detailAccountId, setDetailAccountId] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState<Account | null>(null)

  const apply = useMutation({
    mutationFn: accountAppApi.apply,
    onSuccess: () => {
      toast.success("Account opened")
      setOpeningKind(null); setForm({}); setTab("ACCOUNTS")
      queryClient.invalidateQueries({ queryKey: ["accounts"] })
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Application failed"))
  })

  const closeAccount = useMutation({
    mutationFn: async (id: string) => (await api.post(`/accounts/${id}/close`)).data,
    onSuccess: () => {
      toast.success("Account closed")
      setConfirmClose(null); setDetailAccountId(null)
      queryClient.invalidateQueries({ queryKey: ["accounts"] })
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not close account"))
  })

  const accounts = accountsQ.data ?? []
  const openAccounts = accounts.filter((a) => a.status !== "CLOSED")

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Banking</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Manage Account</h1>
      </div>

      <div className="card flex flex-wrap items-center gap-1 p-1">
        {[
          { k: "ACCOUNTS", l: "My Accounts", icon: Wallet },
          { k: "INTERNAL_TRANSFER", l: "Internal Transfer", icon: ArrowLeftRight },
          { k: "OPEN", l: "Open Account", icon: PiggyBank }
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as Tab)}
            className={cn(
              "flex-1 min-w-[140px] rounded-lg px-3 py-2 text-sm font-semibold",
              tab === t.k ? "bg-brand-600 text-white" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            )}
          >
            <t.icon className="mr-1.5 inline h-3.5 w-3.5" />
            {t.l}
          </button>
        ))}
      </div>

      {tab === "ACCOUNTS" && (
        <div className="grid gap-3 md:grid-cols-2">
          {accountsQ.isLoading ? (
            [0,1].map((i) => <div key={i} className="skeleton h-24" />)
          ) : accounts.length === 0 ? (
            <div className="col-span-2 rounded-xl bg-slate-50 py-6 text-center text-sm text-slate-500">No accounts yet</div>
          ) : accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => setDetailAccountId(a.id)}
              className="card flex items-center gap-3 p-4 text-left hover:-translate-y-0.5 hover:border-brand-300 transition"
            >
              <div className={cn(
                "grid h-11 w-11 place-items-center rounded-xl text-white",
                a.status === "CLOSED"
                  ? "bg-slate-400"
                  : "bg-gradient-to-br from-brand-500 to-brand-700"
              )}>
                <Wallet className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-bold">
                  {a.displayName || (a.kind ? a.kind[0] + a.kind.slice(1).toLowerCase() + " Account" : "Account")}
                  {a.isPrimary && (
                    <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                      Primary
                    </span>
                  )}
                  {a.status === "CLOSED" && (
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500">
                      Closed
                    </span>
                  )}
                </div>
                <div className="font-mono text-xs text-slate-500">{a.accountNumber || shortId(a.id, 10, 6)}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">Balance</div>
                <div className="font-bold">{formatCurrency(a.balance, a.currency)}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </button>
          ))}
        </div>
      )}

      {tab === "INTERNAL_TRANSFER" && (
        <InternalTransferPanel accounts={openAccounts} onDone={() => {
          queryClient.invalidateQueries({ queryKey: ["accounts"] })
          queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
          queryClient.invalidateQueries({ queryKey: ["transactions"] })
        }} />
      )}

      {tab === "OPEN" && (
        <>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {TYPES.map((t) => (
              <button
                key={t.kind}
                onClick={() => { setOpeningKind(t.kind); setForm({}) }}
                className={cn(
                  "card flex items-start gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-300",
                  openingKind === t.kind && "border-brand-400 ring-2 ring-brand-500/20"
                )}
              >
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                  <t.icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{t.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{t.blurb}</div>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-400" />
              </button>
            ))}
          </div>

          {openingKind && (
            <form onSubmit={(e) => {
              e.preventDefault()
              const extraKeys = EXTRA_FIELDS[openingKind]?.map((f) => f.key) ?? []
              const extra: Record<string, string> = {}
              for (const k of extraKeys) if (form[k]) extra[k] = form[k]
              apply.mutate({
                kind: openingKind as any,
                applicantName: form.applicantName || user?.name || "",
                pan: (form.pan || "").toUpperCase(),
                pinCode: form.pinCode || "",
                occupation: form.occupation || "",
                mobileNumber: form.mobileNumber || user?.mobileNumber || "",
                extra
              })
            }} className="card p-6">
              <div className="mb-4 text-sm font-bold">Open a {TYPES.find((t) => t.kind === openingKind)?.name}</div>
              <div className="grid gap-4 md:grid-cols-2">
                <div><label className="label">Full name</label><input className="input" value={form.applicantName || user?.name || ""} onChange={(e) => setForm({ ...form, applicantName: e.target.value })} required /></div>
                <div><label className="label">PAN</label><input className="input font-mono uppercase" placeholder="AAAAA9999A" maxLength={10} value={form.pan || ""} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} required /></div>
                <div><label className="label">PIN / Postal Code</label><input className="input font-mono" placeholder="6-digit PIN" maxLength={6} inputMode="numeric" value={form.pinCode || ""} onChange={(e) => setForm({ ...form, pinCode: e.target.value.replace(/\D/g, "") })} required /></div>
                <div><label className="label">Occupation</label><input className="input" placeholder="e.g. Software engineer" value={form.occupation || ""} onChange={(e) => setForm({ ...form, occupation: e.target.value })} required /></div>
                <div><label className="label">Mobile number</label><input className="input font-mono" maxLength={10} inputMode="numeric" value={form.mobileNumber || user?.mobileNumber || ""} onChange={(e) => setForm({ ...form, mobileNumber: e.target.value.replace(/\D/g, "") })} required /></div>
                {(EXTRA_FIELDS[openingKind] ?? []).map((f) => (
                  <div key={f.key}><label className="label">{f.label}</label><input className="input" placeholder={f.placeholder} value={form[f.key] || ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /></div>
                ))}
              </div>
              <div className="mt-6 flex gap-2">
                <button type="submit" className="btn-primary" disabled={apply.isPending}>{apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Apply Now</button>
                <button type="button" onClick={() => setOpeningKind(null)} className="btn-secondary">Cancel</button>
              </div>
            </form>
          )}
        </>
      )}

      {detailAccountId && (
        <AccountDetailModal
          accountId={detailAccountId}
          onClose={() => setDetailAccountId(null)}
          onRequestClose={(acc) => setConfirmClose(acc)}
        />
      )}

      {confirmClose && (
        <ConfirmCloseAccountModal
          account={confirmClose}
          pending={closeAccount.isPending}
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => closeAccount.mutate(confirmClose.id)}
        />
      )}
    </div>
  )
}

/* ----------------------------- Account detail ----------------------------- */

function AccountDetailModal({
  accountId,
  onClose,
  onRequestClose
}: {
  accountId: string
  onClose: () => void
  onRequestClose: (acc: Account) => void
}) {
  const detailQ = useQuery({
    queryKey: ["account-detail", accountId],
    queryFn: async () => (await api.get(`/accounts/${accountId}/detail`)).data
  })

  const account: any = detailQ.data?.account
  const canClose = account && !account.isPrimary && account.status !== "CLOSED"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <div className="text-sm font-bold">Account Details</div>
          <button onClick={onClose} className="btn-ghost !p-2"><X className="h-4 w-4" /></button>
        </div>

        {detailQ.isLoading || !account ? (
          <div className="p-6"><div className="skeleton h-40 w-full" /></div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                <Wallet className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-bold">
                  {account.displayName || `${account.kind} Account`}
                  {account.isPrimary && (
                    <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">Primary</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">Opened {formatDate(account.createdAt)}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Account number">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{account.maskedNumber || account.accountNumber || shortId(account.id, 10, 6)}</span>
                  {account.accountNumber && (
                    <button
                      onClick={() => { navigator.clipboard.writeText(account.accountNumber); toast.success("Copied") }}
                      className="text-slate-400 hover:text-brand-600"
                      title="Copy full number"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </Field>
              <Field label="Type">{account.kind}</Field>
              <Field label="Status">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-bold",
                  account.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" :
                  account.status === "FROZEN" ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" :
                  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                )}>{account.status}</span>
              </Field>
              <Field label="Currency">{account.currency}</Field>
              <Field label="Available balance" wide>
                <span className="text-lg font-black">{formatCurrency(account.balance, account.currency)}</span>
              </Field>
              {account.closedAt && (
                <Field label="Closed at" wide>{formatDate(account.closedAt)}</Field>
              )}
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
                Recent transactions
              </div>
              {(detailQ.data.recentTransactions ?? []).length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-3 text-center text-xs text-slate-500 dark:bg-slate-800/50">
                  No transactions yet
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                  {detailQ.data.recentTransactions.slice(0, 5).map((t: any) => (
                    <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                      <span className={cn(
                        "font-semibold",
                        t.direction === "IN" ? "text-emerald-600" : "text-rose-600"
                      )}>{t.direction === "IN" ? "+" : "−"} {formatCurrency(t.amount)}</span>
                      <span className="flex-1 truncate text-slate-500">{t.description || t.category || "—"}</span>
                      <span className="text-slate-400">{formatDate(t.createdAt).split(",")[0]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex justify-between gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <button
                onClick={() => onRequestClose(account)}
                disabled={!canClose}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold",
                  canClose
                    ? "text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                    : "cursor-not-allowed text-slate-400"
                )}
                title={account.isPrimary ? "Primary account cannot be closed" : account.status === "CLOSED" ? "Already closed" : "Close account"}
              >
                <Trash2 className="h-4 w-4" />
                {account.isPrimary ? "Primary — cannot close" : account.status === "CLOSED" ? "Closed" : "Close account"}
              </button>
              <button onClick={onClose} className="btn-secondary">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("rounded-xl bg-slate-50 p-3 dark:bg-slate-900/40", wide && "col-span-2")}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm text-slate-900 dark:text-slate-100">{children}</div>
    </div>
  )
}

function ConfirmCloseAccountModal({
  account, pending, onCancel, onConfirm
}: { account: Account; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <div className="p-5">
          <div className="text-lg font-bold">Close account?</div>
          <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            You're about to close <strong>{account.displayName || account.kind + " Account"}</strong>
            {" "}(<span className="font-mono">{account.accountNumber || shortId(account.id, 10, 6)}</span>).
            <br /><br />
            The account will be marked <strong>CLOSED</strong> and its historical transactions
            will remain in your records. This action can't be undone.
          </div>
          <div className="mt-4 rounded-xl bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            Balance must be zero. Any remaining funds will need to be moved out first.
          </div>
        </div>
        <div className="flex gap-2 border-t border-slate-100 p-3 dark:border-slate-800">
          <button className="btn-secondary flex-1" onClick={onCancel}>Cancel</button>
          <button className="btn-primary flex-1 !bg-rose-600 hover:!bg-rose-700" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Close account
          </button>
        </div>
      </div>
    </div>
  )
}

/* --------------------------- Internal Transfer --------------------------- */

function InternalTransferPanel({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const [step, setStep] = useState<"FORM" | "CONFIRM">("FORM")
  const [fromId, setFromId] = useState(accounts[0]?.id || "")
  const [toId, setToId] = useState(accounts[1]?.id || "")
  const [amount, setAmount] = useState("")
  const [remarks, setRemarks] = useState("")
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey())

  useEffect(() => {
    if (!fromId && accounts[0]) setFromId(accounts[0].id)
    if (!toId && accounts[1]) setToId(accounts[1].id)
  }, [accounts])

  const from = useMemo(() => accounts.find((a) => a.id === fromId), [accounts, fromId])
  const to = useMemo(() => accounts.find((a) => a.id === toId), [accounts, toId])
  const numericAmount = Number(amount || 0)
  const insufficient = from && numericAmount > 0 && numericAmount > from.balance
  const sameAccount = fromId && toId && fromId === toId

  const mutation = useMutation({
    mutationFn: () => transactionsApi.create({
      fromAccount: fromId,
      toAccount: toId,
      amount: numericAmount,
      idempotencyKey,
      description: remarks || `Internal transfer`
    }),
    onSuccess: () => {
      toast.success("Transfer complete")
      setStep("FORM"); setAmount(""); setRemarks(""); setIdempotencyKey(newIdempotencyKey())
      onDone()
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Transfer failed"))
  })

  if (accounts.length < 2) {
    return (
      <div className="card p-6 text-center text-sm text-slate-500">
        You need at least two open accounts to move funds internally.
      </div>
    )
  }

  if (step === "CONFIRM") {
    return (
      <div className="card mx-auto max-w-lg p-6">
        <div className="text-lg font-bold">Confirm internal transfer</div>
        <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-900/40">
          <div className="flex justify-between"><span className="text-slate-500">From</span><span className="font-mono">{from?.accountNumber || shortId(fromId, 8, 4)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">To</span><span className="font-mono">{to?.accountNumber || shortId(toId, 8, 4)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Amount</span><span className="text-lg font-black">{formatCurrency(numericAmount)}</span></div>
          {remarks && <div className="flex justify-between"><span className="text-slate-500">Remarks</span><span>{remarks}</span></div>}
        </div>
        <div className="mt-6 flex gap-2">
          <button className="btn-secondary flex-1" onClick={() => setStep("FORM")}>Back</button>
          <button className="btn-primary flex-[2]" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Transfer
          </button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault()
      if (!numericAmount) return toast.error("Enter an amount")
      if (sameAccount) return toast.error("Source and destination must differ")
      if (insufficient) return toast.error("Insufficient balance")
      setStep("CONFIRM")
    }} className="card p-6">
      <div className="text-sm font-bold">Move funds between your accounts</div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div><label className="label">From account</label>
          <select className="input" value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber || shortId(a.id, 8, 4)} · {a.displayName || a.kind} · {formatCurrency(a.balance, a.currency)}
              </option>
            ))}
          </select>
          {from && (
            <div className="mt-1.5 text-xs text-slate-500">
              Available: <span className="font-semibold text-slate-700 dark:text-slate-300">{formatCurrency(from.balance, from.currency)}</span>
            </div>
          )}
        </div>
        <div><label className="label">To account</label>
          <select className="input" value={toId} onChange={(e) => setToId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber || shortId(a.id, 8, 4)} · {a.displayName || a.kind}
              </option>
            ))}
          </select>
          {sameAccount && (
            <div className="mt-1.5 text-xs text-rose-600">Cannot send to the same account</div>
          )}
        </div>
        <div className="md:col-span-2"><label className="label">Amount</label>
          <div className="relative">
            <span className="absolute inset-y-0 left-4 flex items-center text-slate-400">₹</span>
            <input className="input pl-8 text-lg font-semibold" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          </div>
          {insufficient && <div className="mt-1.5 text-xs text-rose-600">Insufficient balance</div>}
        </div>
        <div className="md:col-span-2"><label className="label">Remarks (optional)</label>
          <input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Move to savings" />
        </div>
      </div>
      <button type="submit" className="btn-primary mt-6" disabled={!numericAmount || Boolean(sameAccount) || Boolean(insufficient)}>
        Review Transfer
      </button>
    </form>
  )
}
