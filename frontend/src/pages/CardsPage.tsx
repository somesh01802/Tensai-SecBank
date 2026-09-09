import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft, CheckCircle2, CreditCard, Eye, EyeOff, Loader2, Plus,
  Snowflake, Sparkles, Star, Sun, Trash2
} from "lucide-react"
import toast from "react-hot-toast"

import { cardsApi } from "@/api/cards"
import { cardProductsApi, rewardsApi } from "@/api/v2"
import { apiErrorMessage } from "@/api/client"
import type {} from "@/types/api"
import { useAuthStore } from "@/stores/authStore"
import type { CardProduct } from "@/types/api"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/EmptyState"

type CardType = "CREDIT" | "DEBIT"
type Category = "EVERYDAY" | "LIFESTYLE" | "PREMIUM"

const CATEGORIES: { key: Category; title: string; blurb: string; icon: any; color: string }[] = [
  { key: "EVERYDAY", title: "Everyday / On-the-Go Spending", blurb: "Groceries, fuel, UPI — earn on every rupee.", icon: CreditCard, color: "from-sky-500 to-sky-700" },
  { key: "LIFESTYLE", title: "High-End Lifestyle Perks", blurb: "Lounges, dining, entertainment.", icon: Sparkles, color: "from-purple-500 to-purple-700" },
  { key: "PREMIUM", title: "Premium Lifestyle Offers", blurb: "Bespoke perks for the extraordinary.", icon: Star, color: "from-amber-500 to-orange-600" }
]

export function CardsPage() {
  useEffect(() => { rewardsApi.event("page.visited.cards").catch(() => {}) }, [])
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)

  const listQ = useQuery({ queryKey: ["cards"], queryFn: cardsApi.list })

  const [applyType, setApplyType] = useState<CardType | null>(null)
  const [category, setCategory] = useState<Category | null>(null)
  const [selectedProd, setSelectedProd] = useState<CardProduct | null>(null)

  const prodsQ = useQuery({
    queryKey: ["card-products", applyType, category],
    queryFn: () => cardProductsApi.list({ category: category || undefined, type: applyType || undefined }),
    enabled: Boolean(applyType && category)
  })

  const [form, setForm] = useState<{ mobileNumber: string; pan: string; dob: string }>({
    mobileNumber: user?.mobileNumber || "",
    pan: "",
    dob: ""
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["cards"] })
    queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] })
  }

  const apply = useMutation({
    mutationFn: cardProductsApi.apply,
    onSuccess: () => {
      toast.success("Card issued!")
      setApplyType(null); setCategory(null); setSelectedProd(null); setForm({ mobileNumber: user?.mobileNumber || "", pan: "", dob: "" })
      invalidate()
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Application failed"))
  })

  const freeze = useMutation({
    mutationFn: cardsApi.freeze,
    onSuccess: () => { toast.success("Card status updated"); invalidate() }
  })

  const remove = useMutation({
    mutationFn: cardsApi.remove,
    onSuccess: () => { toast.success("Card cancelled"); invalidate() }
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Payment</div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Cards</h1>
        </div>
        {!applyType && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => { setApplyType("DEBIT"); setCategory(null); setSelectedProd(null) }}>
              <Plus className="h-4 w-4" /> New Debit Card
            </button>
            <button className="btn-primary" onClick={() => { setApplyType("CREDIT"); setCategory(null); setSelectedProd(null) }}>
              <Plus className="h-4 w-4" /> New Credit Card
            </button>
          </div>
        )}
      </div>

      {applyType && (
        <div className="card p-6">
          <button
            onClick={() => { setApplyType(null); setCategory(null); setSelectedProd(null) }}
            className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>

          {!category ? (
            <>
              <div className="text-lg font-bold">Choose a {applyType.toLowerCase()} card category</div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setCategory(c.key)}
                    className="rounded-2xl border border-slate-200 bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-brand-300 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className={cn("grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br text-white", c.color)}>
                      <c.icon className="h-5 w-5" />
                    </div>
                    <div className="mt-3 font-bold">{c.title}</div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{c.blurb}</div>
                  </button>
                ))}
              </div>
            </>
          ) : !selectedProd ? (
            <>
              <div className="text-lg font-bold">
                {CATEGORIES.find((c) => c.key === category)?.title}
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {prodsQ.isLoading ? (
                  [0,1].map((i) => <div key={i} className="skeleton h-32" />)
                ) : (
                  prodsQ.data?.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedProd(p)}
                      className="rounded-2xl border border-slate-200 bg-white p-5 text-left transition hover:border-brand-300 dark:border-slate-800 dark:bg-slate-900"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-bold">{p.name}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{p.tagline}</div>
                        </div>
                        <div className="text-right text-xs">
                          <div className="font-semibold">Annual fee</div>
                          <div>{p.annualFee > 0 ? `₹ ${p.annualFee}` : "Free"}</div>
                        </div>
                      </div>
                      <ul className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                        {p.benefits.slice(0, 3).map((b, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                            {b}
                          </li>
                        ))}
                      </ul>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!/^\d{10}$/.test(form.mobileNumber)) return toast.error("Mobile must be 10 digits")
                if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(form.pan)) return toast.error("Invalid PAN format")
                if (!form.dob) return toast.error("DOB required")
                apply.mutate({
                  productCode: selectedProd.code,
                  mobileNumber: form.mobileNumber,
                  pan: form.pan,
                  dob: form.dob
                })
              }}
              className="space-y-4"
            >
              <div className="text-lg font-bold">Apply for {selectedProd.name}</div>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label className="label">Mobile Number</label>
                  <input className="input font-mono" maxLength={10} inputMode="numeric" value={form.mobileNumber} onChange={(e) => setForm({ ...form, mobileNumber: e.target.value.replace(/\D/g, "") })} required />
                </div>
                <div>
                  <label className="label">PAN</label>
                  <input className="input font-mono uppercase" maxLength={10} value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} placeholder="AAAAA9999A" required />
                </div>
                <div>
                  <label className="label">Date of Birth</label>
                  <input className="input" type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} required />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" className="btn-primary" disabled={apply.isPending}>
                  {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Submit application
                </button>
                <button type="button" onClick={() => setSelectedProd(null)} className="btn-secondary">Back</button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Existing cards */}
      {(listQ.data?.length ?? 0) === 0 ? (
        !applyType ? (
          <EmptyState
            icon={<CreditCard className="h-6 w-6" />}
            title="No cards yet"
            description="Issue your first virtual card using the buttons above."
          />
        ) : null
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {listQ.data!.map((c) => (
            <CardTile key={c.id} card={c} onFreeze={() => freeze.mutate(c.id)} onRemove={() => remove.mutate(c.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function CardTile({
  card,
  onFreeze,
  onRemove
}: {
  card: any
  onFreeze: () => void
  onRemove: () => void
}) {
  const [reveal, setReveal] = useState<{ fullNumber: string; cvv: string; expiry: string } | null>(null)
  const [revealing, setRevealing] = useState(false)

  async function toggleReveal() {
    if (reveal) { setReveal(null); return }
    setRevealing(true)
    try {
      const details = await cardProductsApi.reveal(card.id)
      setReveal(details)
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not reveal"))
    } finally {
      setRevealing(false)
    }
  }

  const bg = card.isFrozen
    ? "linear-gradient(135deg,#94a3b8,#475569)"
    : card.colorHint === "gold"
    ? "linear-gradient(135deg,#fbbf24,#b45309)"
    : card.colorHint === "purple"
    ? "linear-gradient(135deg,#a855f7,#6b21a8)"
    : card.colorHint === "sky"
    ? "linear-gradient(135deg,#38bdf8,#0369a1)"
    : "linear-gradient(135deg,#fbbf24,#fb7185)"

  const formatted = reveal
    ? reveal.fullNumber.match(/.{1,4}/g)?.join(" ")
    : "•••• •••• •••• " + card.lastFour

  return (
    <div className="card p-5">
      <div className="relative h-44 rounded-2xl p-4 text-white shadow-lg" style={{ background: bg }}>
        <div className="flex items-start justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-widest">
            {card.type === "CREDIT" ? "Credit Card" : "Debit Card"}
          </div>
          <div className="text-lg font-black italic tracking-wider">
            <span className="text-red-500">●</span>
            <span className="-ml-2 text-amber-400">●</span>
          </div>
        </div>
        <div className="mt-8 font-mono text-lg tracking-widest">
          {formatted}
        </div>
        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-[9px] uppercase opacity-70">Holder</div>
            <div className="text-sm font-semibold">{card.holderName}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase opacity-70">Expiry</div>
            <div className="text-sm font-semibold">
              {reveal
                ? reveal.expiry
                : `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).padStart(2, "0")}`}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase opacity-70">CVV</div>
            <div className="text-sm font-semibold">{reveal ? reveal.cvv : "•••"}</div>
          </div>
        </div>
        {card.isFrozen && (
          <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-white/25 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
            <Snowflake className="h-3 w-3" /> Frozen
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button className="btn-secondary flex-1" onClick={toggleReveal} disabled={revealing}>
          {revealing ? <Loader2 className="h-4 w-4 animate-spin" /> : reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {reveal ? "Hide" : "Reveal"}
        </button>
        <button className="btn-secondary flex-1" onClick={onFreeze}>
          {card.isFrozen ? <Sun className="h-4 w-4" /> : <Snowflake className="h-4 w-4" />}
          {card.isFrozen ? "Unfreeze" : "Freeze"}
        </button>
        <button className="btn-ghost !p-2 text-rose-500" onClick={onRemove} title="Cancel card">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
