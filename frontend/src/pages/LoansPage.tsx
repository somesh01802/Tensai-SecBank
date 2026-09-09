import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Landmark, Home, Car, GraduationCap, Sparkles, Coins, Briefcase,
  Loader2, Calculator, CheckCircle2, ArrowLeft, X, Trash2, FileText
} from "lucide-react"
import toast from "react-hot-toast"

import { loansApi, rewardsApi } from "@/api/v2"
import { apiErrorMessage } from "@/api/client"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { LoanProduct } from "@/types/api"
import { cn } from "@/lib/utils"

const ICON: Record<string, any> = {
  HOME: Home,
  CAR: Car,
  PERSONAL: Sparkles,
  EDUCATION: GraduationCap,
  GOLD: Coins,
  BUSINESS: Briefcase
}

export function LoansPage() {
  useEffect(() => { rewardsApi.event("page.visited.loans").catch(() => {}) }, [])

  const queryClient = useQueryClient()
  const productsQ = useQuery({ queryKey: ["loan-products"], queryFn: loansApi.products })
  const appsQ = useQuery({ queryKey: ["loan-applications"], queryFn: loansApi.applications })

  const [selected, setSelected] = useState<LoanProduct | null>(null)
  const [principal, setPrincipal] = useState("")
  const [tenure, setTenure] = useState("")
  const [tenureVariations, setTenureVariations] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)

  const calcQ = useQuery({
    queryKey: ["loan-calc", selected?.code, principal, tenure],
    queryFn: () => loansApi.calculate({
      productCode: selected!.code,
      principal: Number(principal),
      tenureMonths: Number(tenure)
    }),
    enabled: Boolean(selected && Number(principal) > 0 && Number(tenure) > 0)
  })

  useEffect(() => {
    if (Number(tenure) > 0) setTenureVariations((v) => v + 1)
  }, [tenure])
  useEffect(() => {
    if (tenureVariations >= 3) rewardsApi.event("loan.tenure.varied").catch(() => {})
  }, [tenureVariations])

  const apply = useMutation({
    mutationFn: loansApi.apply,
    onSuccess: () => {
      toast.success("Loan application submitted")
      setSelected(null)
      setPrincipal(""); setTenure("")
      queryClient.invalidateQueries({ queryKey: ["loan-applications"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Application failed"))
  })

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Products</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Loans</h1>
      </div>

      {!selected ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {productsQ.data?.map((p) => {
              const Icon = ICON[p.code] || Landmark
              return (
                <div key={p.id} className="group card p-5">
                  <div className="flex items-start gap-3">
                    <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <div className="font-bold">{p.name}</div>
                        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                          {p.interestRate}% p.a.
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{p.description}</div>
                      <div className="mt-2 text-[11px] text-slate-400">
                        {formatCurrency(p.minAmount)} – {formatCurrency(p.maxAmount)} · {p.minTenure}–{p.maxTenure} months
                      </div>
                      <button
                        onClick={() => setSelected(p)}
                        className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
                      >
                        Apply Now →
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {(appsQ.data?.length ?? 0) > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Your applications</div>
              <div className="card divide-y divide-slate-100 dark:divide-slate-800">
                {appsQ.data!.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setDetailId(a.id)}
                    className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-900/40"
                  >
                    <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                      <Landmark className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{a.product?.name || "Loan"}</div>
                      <div className="text-xs text-slate-500">
                        {formatCurrency(a.principal)} · {a.tenureMonths} months · EMI {formatCurrency(a.emi)}
                      </div>
                    </div>
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold",
                      a.status === "APPROVED" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" :
                      a.status === "REJECTED" ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" :
                      a.status === "CLOSED" ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" :
                      "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                    )}>
                      {a.status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="card p-6">
          <button
            onClick={() => setSelected(null)}
            className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="mb-6 flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
              <Calculator className="h-6 w-6" />
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
                Apply · {selected.interestRate}% p.a.
              </div>
              <div className="text-lg font-bold">{selected.name}</div>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="label">Amount</label>
                <input
                  className="input text-lg font-semibold"
                  inputMode="numeric"
                  placeholder={`${selected.minAmount} – ${selected.maxAmount}`}
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value.replace(/\D/g, ""))}
                />
                <input
                  type="range"
                  min={selected.minAmount}
                  max={selected.maxAmount}
                  step={selected.minAmount}
                  value={principal || selected.minAmount}
                  onChange={(e) => setPrincipal(e.target.value)}
                  className="mt-2 w-full accent-brand-600"
                />
                <div className="mt-1 text-xs text-slate-500">
                  Between {formatCurrency(selected.minAmount)} and {formatCurrency(selected.maxAmount)}
                </div>
              </div>
              <div>
                <label className="label">Tenure (months)</label>
                <input
                  className="input text-lg font-semibold"
                  inputMode="numeric"
                  placeholder={`${selected.minTenure} – ${selected.maxTenure}`}
                  value={tenure}
                  onChange={(e) => setTenure(e.target.value.replace(/\D/g, ""))}
                />
                <input
                  type="range"
                  min={selected.minTenure}
                  max={selected.maxTenure}
                  value={tenure || selected.minTenure}
                  onChange={(e) => setTenure(e.target.value)}
                  className="mt-2 w-full accent-brand-600"
                />
                <div className="mt-1 text-xs text-slate-500">
                  Between {selected.minTenure} and {selected.maxTenure} months
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 p-5 dark:bg-slate-900/40">
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Repayment summary</div>
              {calcQ.isLoading && Number(principal) > 0 && Number(tenure) > 0 ? (
                <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Calculating…
                </div>
              ) : calcQ.data ? (
                <div className="mt-4 space-y-2 text-sm">
                  <Row label="Monthly EMI" value={formatCurrency(calcQ.data.emi)} big />
                  <Row label="Interest rate" value={`${calcQ.data.interestRate}% p.a.`} />
                  <Row label="Total interest" value={formatCurrency(calcQ.data.totalInterest)} />
                  <Row label="Total repayment" value={formatCurrency(calcQ.data.totalRepayment)} />
                </div>
              ) : (
                <div className="mt-4 text-sm text-slate-500">Enter amount + tenure to preview your EMI.</div>
              )}

              <button
                onClick={() => apply.mutate({
                  productCode: selected.code,
                  principal: Number(principal),
                  tenureMonths: Number(tenure)
                })}
                className="btn-primary mt-6 w-full"
                disabled={!calcQ.data || apply.isPending}
              >
                {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Apply Loan
              </button>
            </div>
          </div>
        </div>
      )}

      {detailId && (
        <LoanDetailModal
          applicationId={detailId}
          onClose={() => setDetailId(null)}
          onClosed={() => queryClient.invalidateQueries({ queryKey: ["loan-applications"] })}
        />
      )}
    </div>
  )
}

function LoanDetailModal({
  applicationId, onClose, onClosed
}: { applicationId: string; onClose: () => void; onClosed: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [reason, setReason] = useState("")
  const detailQ = useQuery({
    queryKey: ["loan-detail", applicationId],
    queryFn: () => loansApi.detail(applicationId)
  })
  const close = useMutation({
    mutationFn: () => loansApi.close(applicationId, reason || undefined),
    onSuccess: () => {
      toast.success("Loan closed")
      onClosed()
      onClose()
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not close loan"))
  })

  const app = detailQ.data?.application as any
  const product = detailQ.data?.product
  const schedule = detailQ.data?.schedule ?? []
  const canClose = app && app.status !== "CLOSED" && app.status !== "REJECTED"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <div className="text-sm font-bold">Loan Details</div>
          <button onClick={onClose} className="btn-ghost !p-2"><X className="h-4 w-4" /></button>
        </div>

        {detailQ.isLoading || !app ? (
          <div className="p-6"><div className="skeleton h-40 w-full" /></div>
        ) : (
          <div className="max-h-[75vh] space-y-4 overflow-y-auto p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                <FileText className="h-6 w-6" />
              </div>
              <div>
                <div className="text-lg font-bold">{product?.name}</div>
                <div className="text-xs text-slate-500">Applied {formatDate(app.createdAt)}</div>
              </div>
              <div className="ml-auto">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-bold",
                  app.status === "APPROVED" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" :
                  app.status === "REJECTED" ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" :
                  app.status === "CLOSED" ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" :
                  "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                )}>{app.status}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Row label="Principal" value={formatCurrency(app.principal)} />
              <Row label="Interest rate" value={`${app.interestRate}% p.a.`} />
              <Row label="Tenure" value={`${app.tenureMonths} months`} />
              <Row label="Monthly EMI" value={formatCurrency(app.emi)} big />
              <Row label="Total interest" value={formatCurrency(app.totalInterest)} />
              <Row label="Total repayment" value={formatCurrency(app.totalRepayment)} />
              {app.closedAt && <Row label="Closed at" value={formatDate(app.closedAt)} />}
              {app.closeReason && <Row label="Reason" value={app.closeReason} />}
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
                Illustrative repayment schedule (first {schedule.length} EMIs)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-bold uppercase text-slate-500">
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-right">EMI</th>
                      <th className="px-2 py-1 text-right">Interest</th>
                      <th className="px-2 py-1 text-right">Principal</th>
                      <th className="px-2 py-1 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((r: any) => (
                      <tr key={r.n} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-2 py-1.5 text-xs">{r.n}</td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatCurrency(r.emi)}</td>
                        <td className="px-2 py-1.5 text-right text-xs text-slate-500">{formatCurrency(r.interest)}</td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatCurrency(r.principal)}</td>
                        <td className="px-2 py-1.5 text-right text-xs font-semibold">{formatCurrency(r.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {canClose && (
              confirm ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-500/30 dark:bg-rose-500/10">
                  <div className="text-sm font-bold text-rose-700 dark:text-rose-200">Close this loan?</div>
                  <div className="mt-1 text-xs text-rose-700/80 dark:text-rose-200/80">
                    The record and full history remain — status becomes {app.status === "PENDING" ? "REJECTED" : "CLOSED"}.
                  </div>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Optional reason (kept in your records)"
                    className="input mt-2 h-16"
                  />
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => setConfirm(false)} className="btn-secondary flex-1">Cancel</button>
                    <button onClick={() => close.mutate()} disabled={close.isPending} className="btn-primary flex-1 !bg-rose-600 hover:!bg-rose-700">
                      {close.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Confirm close
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                  <button onClick={() => setConfirm(true)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10">
                    <Trash2 className="h-4 w-4" />
                    Close / Cancel loan
                  </button>
                  <button onClick={onClose} className="btn-secondary">Done</button>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={cn("font-semibold", big && "text-lg font-black text-brand-600")}>{value}</span>
    </div>
  )
}
