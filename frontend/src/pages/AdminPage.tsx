import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import {
  ArrowLeftRight, ChevronLeft, ChevronRight, LayoutDashboard, Loader2, LogOut, MessageSquare, ScrollText, Search, Users, X
} from "lucide-react"
import type { AxiosError } from "axios"

import { adminApi, type AdminTxRow } from "@/api/admin"
import { authApi } from "@/api/auth"
import { useAuthStore } from "@/stores/authStore"
import { LogoMark } from "@/components/Logo"
import { cn, formatCurrency, formatDate, shortId } from "@/lib/utils"

/**
 * Admin console. Every request goes to /api/admin/*, where the server enforces
 * the ADMIN role and writes an audit record. The API never returns passwords,
 * MPINs, card numbers, CVVs or tokens, so nothing here can display them.
 */

type Tab = "overview" | "customers" | "transactions" | "feedback" | "audit"
const TABS: { id: Tab; label: string; Icon: typeof Users }[] = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "customers", label: "Customers", Icon: Users },
  { id: "transactions", label: "Transactions", Icon: ArrowLeftRight },
  { id: "feedback", label: "Feedback", Icon: MessageSquare },
  { id: "audit", label: "Audit log", Icon: ScrollText }
]
const FAILURE_CATEGORIES = ["insufficient_funds", "invalid_beneficiary", "invalid_account", "transfer_limit", "validation_error",
  "duplicate_request", "forbidden", "processor_timeout", "network_failure", "fraud_timeout", "db_concurrency", "service_outage", "internal_error"]

// ------------------------------------------------------------------ shared bits

type Tone = "green" | "red" | "amber" | "slate" | "violet" | "blue"
const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  red: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  violet: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300",
  blue: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
}
function Badge({ tone = "slate", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={cn("badge whitespace-nowrap", TONES[tone])}>{children}</span>
}
const outcomeTone = (o?: string | null): Tone => (o === "SUCCESS" ? "green" : o === "FAILURE" ? "red" : "amber")
const ratingTone = (r?: string | null): Tone => (r === "HAPPY" ? "green" : r === "SATISFIED" ? "amber" : r === "NOT_SATISFIED" ? "red" : "slate")
const pretty = (s?: string | null) => (s ? s.replace(/_/g, " ").toLowerCase() : "—")
const money = (n?: number | null) => (n === null || n === undefined ? "—" : formatCurrency(n))
const when = (iso?: string | null) => (iso ? formatDate(iso) : "—")

function SyntheticBadge({ synthetic }: { synthetic: boolean }) {
  return synthetic ? <Badge tone="violet">synthetic</Badge> : <Badge tone="blue">real</Badge>
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-slate-800">
      <span>{total.toLocaleString()} result{total === 1 ? "" : "s"} · page {page} of {pages}</span>
      <div className="flex gap-1">
        <button className="btn-ghost px-2 py-1" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <button className="btn-ghost px-2 py-1" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  )
}

function QueryState({ isLoading, error }: { isLoading: boolean; error: unknown }) {
  if (isLoading) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  if (error) {
    const e = error as AxiosError<{ message?: string }>
    return <div className="p-6 text-sm text-rose-600">{e.response?.data?.message || e.message || "Failed to load"}</div>
  }
  return null
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cn("px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500", right ? "text-right" : "text-left")}>{children}</th>
}
function Td({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }) {
  return <td className={cn("px-4 py-2.5 align-top", right && "text-right", mono && "font-mono text-xs")}>{children}</td>
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40" onClick={onClose}>
      <aside role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-3xl overflow-y-auto bg-white p-6 shadow-2xl dark:bg-slate-950">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{title}</h2>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
      {children}
    </section>
  )
}

/** Compact key/value table for drawer sections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MiniTable({ rows, cols }: { rows: any[]; cols: [string, (r: any) => React.ReactNode][] }) {
  if (!rows?.length) return <p className="text-sm text-slate-400">None</p>
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-900"><tr>{cols.map(([h]) => <Th key={h}>{h}</Th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r, i) => <tr key={r.id ?? i}>{cols.map(([h, f]) => <Td key={h}>{f(r)}</Td>)}</tr>)}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ page

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("overview")
  const user = useAuthStore((s) => s.user)
  const clear = useAuthStore((s) => s.clear)
  const navigate = useNavigate()

  async function signOut() {
    try { await authApi.logout() } catch { /* ignore */ }
    clear()
    navigate("/login", { replace: true })
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <LogoMark size={32} />
          <div className="flex-1">
            <div className="text-sm font-bold text-slate-900 dark:text-slate-100">Tensai SecBank · Admin console</div>
            <div className="text-xs text-slate-500">Signed in as {user?.name} · every action is audited</div>
          </div>
          <button className="btn-ghost text-xs" onClick={signOut}><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6" aria-label="Admin sections">
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
              className={cn("flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold transition",
                tab === id ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === "overview" && <Overview />}
        {tab === "customers" && <Customers />}
        {tab === "transactions" && <Transactions />}
        {tab === "feedback" && <Feedback />}
        {tab === "audit" && <Audit />}
      </main>
    </div>
  )
}

// ------------------------------------------------------------------ overview

function Overview() {
  const { data, isLoading, error } = useQuery({ queryKey: ["admin", "summary"], queryFn: adminApi.summary, refetchInterval: 30_000 })
  if (!data) return <QueryState isLoading={isLoading} error={error} />
  const a = data.attempts24h
  const rate = a.total ? ((a.success / a.total) * 100).toFixed(1) + "%" : "—"
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Customers" value={data.customers.real.toLocaleString()} sub={`+ ${data.customers.synthetic.toLocaleString()} synthetic test users`} />
        <Stat label="Live deposits" value={money(data.accounts.realBalance)} sub={`${data.accounts.active.toLocaleString()} active accounts`} />
        <Stat label="Attempts · 24h" value={a.total.toLocaleString()} sub={`success rate ${rate} · avg ${a.avgDurationMs} ms`} />
        <Stat label="Logins · 24h" value={data.logins24h.success.toLocaleString()} sub={`${data.logins24h.failure.toLocaleString()} failed`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold">Failure categories · 24h</h3>
          {a.failureCategories.length ? a.failureCategories.map((c) => (
            <div key={c.category} className="mb-2">
              <div className="flex justify-between text-xs"><span className="capitalize">{pretty(c.category)}</span><span>{c.count}</span></div>
              <div className="mt-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
                <div className="h-2 rounded-full bg-rose-500" style={{ width: `${(c.count / Math.max(1, a.failure)) * 100}%` }} />
              </div>
            </div>
          )) : <p className="text-sm text-slate-400">No failures in the last 24 hours</p>}
        </div>
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold">Customer satisfaction (all time)</h3>
          {data.feedback.length ? (
            <div className="flex flex-wrap gap-3">
              {data.feedback.map((f) => (
                <div key={f.rating} className="rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
                  <Badge tone={ratingTone(f.rating)}>{pretty(f.rating)}</Badge>
                  <div className="mt-1 text-xl font-bold">{f.count.toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-400">No feedback yet</p>}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ customers

function Customers() {
  const [input, setInput] = useState("")
  const [q, setQ] = useState("")
  const [synthetic, setSynthetic] = useState("real")
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["admin", "customers", q, synthetic, page],
    queryFn: () => adminApi.customers({ q, synthetic, page, pageSize: 20 }),
    placeholderData: keepPreviousData
  })
  return (
    <div className="card overflow-hidden">
      <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4 dark:border-slate-800"
        onSubmit={(e) => { e.preventDefault(); setQ(input.trim()); setPage(1) }}>
        <div className="min-w-[240px] flex-1">
          <label htmlFor="cust-q" className="label">Search</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input id="cust-q" className="input pl-9" placeholder="Name, email, mobile or customer id" value={input} onChange={(e) => setInput(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="cust-type" className="label">Type</label>
          <select id="cust-type" className="input" value={synthetic} onChange={(e) => { setSynthetic(e.target.value); setPage(1) }}>
            <option value="real">Real customers</option>
            <option value="synthetic">Synthetic test users</option>
            <option value="all">All</option>
          </select>
        </div>
        <button className="btn-primary" type="submit">{isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search</button>
      </form>
      {!data ? <QueryState isLoading={isLoading} error={error} /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900"><tr><Th>Customer</Th><Th>Mobile</Th><Th right>Accounts</Th><Th right>Balance</Th><Th>Last login</Th><Th>Type</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900" onClick={() => setOpenId(c.id)}>
                    <Td><div className="font-semibold">{c.name}</div><div className="text-xs text-slate-500">{c.email}</div></Td>
                    <Td mono>{c.mobile ?? "—"}</Td>
                    <Td right>{c.accountsCount}</Td>
                    <Td right>{money(c.totalBalance)}</Td>
                    <Td>{when(c.lastLoginAt)}</Td>
                    <Td><SyntheticBadge synthetic={c.isSynthetic} /></Td>
                  </tr>
                ))}
                {!data.items.length && <tr><Td>No customers match.</Td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
      {openId && <CustomerDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function CustomerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["admin", "customer", id], queryFn: () => adminApi.customer(id) })
  const c = data?.customer
  return (
    <Drawer title={c ? c.name : "Customer"} onClose={onClose}>
      {!data ? <QueryState isLoading={isLoading} error={error} /> : (
        <>
          <div className="mb-6 flex flex-wrap gap-2 text-sm text-slate-600 dark:text-slate-300">
            <span>{c.email}</span>·<span className="font-mono">{c.mobile ?? "—"}</span>·<span>{c.occupation ?? "—"}</span>·
            <span>joined {when(c.createdAt)}</span><SyntheticBadge synthetic={c.isSynthetic} />
          </div>
          <Section title="Accounts & balances">
            <MiniTable rows={data.accounts} cols={[["Account", (r) => <span className="font-mono">{r.accountNumber}</span>], ["Type", (r) => pretty(r.kind)],
              ["Status", (r) => <Badge tone={r.status === "ACTIVE" ? "green" : "slate"}>{pretty(r.status)}</Badge>], ["Balance", (r) => money(r.balance)],
              ["Primary", (r) => (r.isPrimary ? "yes" : "")]]} />
          </Section>
          <Section title="Cards (masked)">
            <MiniTable rows={data.cards} cols={[["Card", (r) => <span className="font-mono">•••• {r.lastFour}</span>], ["Network", (r) => r.network],
              ["Type", (r) => pretty(r.type)], ["Expiry", (r) => `${String(r.expiryMonth).padStart(2, "0")}/${r.expiryYear}`],
              ["Status", (r) => (r.isFrozen ? <Badge tone="amber">frozen</Badge> : <Badge tone="green">active</Badge>)]]} />
          </Section>
          <Section title="Loans">
            <MiniTable rows={data.loans} cols={[["Product", (r) => r.product], ["Principal", (r) => money(r.principal)], ["EMI", (r) => money(r.emi)],
              ["Tenure", (r) => `${r.tenureMonths} mo`], ["Status", (r) => pretty(r.status)]]} />
          </Section>
          <Section title="Bills">
            <MiniTable rows={data.bills} cols={[["Biller", (r) => r.billerName], ["Category", (r) => pretty(r.category)], ["Amount", (r) => money(r.amount)],
              ["Due", (r) => r.dueDate ?? "—"], ["Status", (r) => <Badge tone={r.status === "PAID" ? "green" : "amber"}>{pretty(r.status)}</Badge>]]} />
          </Section>
          <Section title="Recent transaction attempts">
            <MiniTable rows={data.attempts} cols={[["When", (r) => when(r.createdAt)], ["Kind", (r) => pretty(r.kind)], ["Amount", (r) => money(r.amount)],
              ["Outcome", (r) => <Badge tone={outcomeTone(r.outcome)}>{pretty(r.outcome)}</Badge>], ["Failure", (r) => pretty(r.errorCategory)],
              ["Feedback", (r) => (r.feedbackStatus ? <Badge tone={ratingTone(r.feedbackRating)}>{pretty(r.feedbackRating ?? r.feedbackStatus)}</Badge> : "—")]]} />
          </Section>
          <Section title="Recent ledger transactions">
            <MiniTable rows={data.transactions} cols={[["When", (r) => when(r.createdAt)], ["Direction", (r) => pretty(r.direction)],
              ["Amount", (r) => money(r.amount)], ["Category", (r) => pretty(r.category)], ["Description", (r) => r.description ?? "—"]]} />
          </Section>
          <Section title="Sign-ins & location consent">
            <MiniTable rows={data.logins} cols={[["When", (r) => when(r.createdAt)], ["Event", (r) => `${r.event} · ${r.method}`],
              ["Outcome", (r) => <Badge tone={r.outcome === "success" ? "green" : "red"}>{r.outcome}</Badge>],
              ["Location", (r) => (r.locationStatus === "granted" ? `${r.latitude}, ${r.longitude}` : pretty(r.locationStatus))]]} />
          </Section>
        </>
      )}
    </Drawer>
  )
}

// ------------------------------------------------------------------ transactions

const emptyTxFilters = { q: "", outcome: "", kind: "", errorCategory: "", synthetic: "real", from: "", to: "" }

function Transactions() {
  const [draft, setDraft] = useState(emptyTxFilters)
  const [filters, setFilters] = useState(emptyTxFilters)
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["admin", "transactions", filters, page],
    queryFn: () => adminApi.transactions({ ...filters, page, pageSize: 25 }),
    placeholderData: keepPreviousData
  })
  const set = (k: keyof typeof emptyTxFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value })
  return (
    <div className="card overflow-hidden">
      <form className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-slate-800"
        onSubmit={(e) => { e.preventDefault(); setFilters(draft); setPage(1) }}>
        <div className="sm:col-span-2"><label htmlFor="tx-q" className="label">Search</label>
          <input id="tx-q" className="input" placeholder="Customer, email, description or reference id" value={draft.q} onChange={set("q")} /></div>
        <div><label htmlFor="tx-out" className="label">Outcome</label>
          <select id="tx-out" className="input" value={draft.outcome} onChange={set("outcome")}>
            <option value="">Any</option><option value="SUCCESS">Success</option><option value="FAILURE">Failure</option><option value="PENDING">Pending</option>
          </select></div>
        <div><label htmlFor="tx-kind" className="label">Kind</label>
          <select id="tx-kind" className="input" value={draft.kind} onChange={set("kind")}>
            <option value="">Any</option><option value="P2P">Internal transfer</option><option value="EXTERNAL">External transfer</option><option value="BILL">Bill payment</option>
          </select></div>
        <div><label htmlFor="tx-cat" className="label">Failure category</label>
          <select id="tx-cat" className="input" value={draft.errorCategory} onChange={set("errorCategory")}>
            <option value="">Any</option>{FAILURE_CATEGORIES.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}
          </select></div>
        <div><label htmlFor="tx-syn" className="label">Activity</label>
          <select id="tx-syn" className="input" value={draft.synthetic} onChange={set("synthetic")}>
            <option value="real">Real customers</option><option value="synthetic">Synthetic</option><option value="all">All</option>
          </select></div>
        <div><label htmlFor="tx-from" className="label">From</label><input id="tx-from" type="date" className="input" value={draft.from} onChange={set("from")} /></div>
        <div><label htmlFor="tx-to" className="label">To</label><input id="tx-to" type="date" className="input" value={draft.to} onChange={set("to")} /></div>
        <div className="flex items-end gap-2 lg:col-span-4">
          <button className="btn-primary" type="submit">{isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Apply</button>
          <button className="btn-ghost" type="button" onClick={() => { setDraft(emptyTxFilters); setFilters(emptyTxFilters); setPage(1) }}>Reset</button>
        </div>
      </form>
      {!data ? <QueryState isLoading={isLoading} error={error} /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900"><tr><Th>When</Th><Th>Reference</Th><Th>Customer</Th><Th>Kind / category</Th><Th right>Amount</Th><Th>Outcome</Th><Th>Feedback</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((t: AdminTxRow) => (
                  <tr key={t.refId} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900" onClick={() => setOpenId(t.refId)}>
                    <Td>{when(t.createdAt)}</Td>
                    <Td mono>{shortId(t.refId)}<div className="text-[10px] text-slate-400">{t.refType.toLowerCase()}</div></Td>
                    <Td><div className="font-semibold">{t.userName}</div>{t.isSynthetic && <Badge tone="violet">synthetic</Badge>}</Td>
                    <Td>{pretty(t.kind)}<div className="text-xs text-slate-500">{pretty(t.category)}{t.counterparty ? ` → ${t.counterparty}` : ""}</div></Td>
                    <Td right>{money(t.amount)}</Td>
                    <Td><Badge tone={outcomeTone(t.outcome)}>{pretty(t.outcome)}</Badge>{t.errorCategory && <div className="mt-1 text-xs text-rose-600">{pretty(t.errorCategory)}</div>}</Td>
                    <Td>{t.feedbackStatus ? <Badge tone={ratingTone(t.feedbackRating)}>{pretty(t.feedbackRating ?? t.feedbackStatus)}</Badge> : "—"}</Td>
                  </tr>
                ))}
                {!data.items.length && <tr><Td>No transactions match.</Td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
      {openId && <TransactionDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function TransactionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["admin", "transaction", id], queryFn: () => adminApi.transaction(id) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attemptCols: [string, (r: any) => React.ReactNode][] = [
    ["When", (r) => when(r.createdAt)], ["Outcome", (r) => <Badge tone={outcomeTone(r.outcome)}>{pretty(r.outcome)}</Badge>],
    ["Failure", (r) => (r.errorCategory ? `${pretty(r.errorCategory)}${r.faultInjected ? " (injected)" : ""}` : "—")],
    ["Duration", (r) => (r.durationMs !== null ? `${r.durationMs} ms` : "—")], ["HTTP", (r) => r.httpStatus ?? "—"],
    ["Trace", (r) => <span className="font-mono text-xs">{r.traceId ? shortId(r.traceId) : "—"}</span>],
    ["Feedback", (r) => (r.feedbackStatus ? <span><Badge tone={ratingTone(r.feedbackRating)}>{pretty(r.feedbackRating ?? r.feedbackStatus)}</Badge>{r.feedbackComment && <div className="mt-1 text-xs italic">“{r.feedbackComment}”</div>}</span> : "—")]
  ]
  return (
    <Drawer title={data?.type === "ATTEMPT" ? "Failed transaction attempt" : "Transaction"} onClose={onClose}>
      {!data ? <QueryState isLoading={isLoading} error={error} /> : data.type === "TRANSACTION" ? (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2">
            <Stat label="Amount" value={money(data.transaction.amount)} sub={`${pretty(data.transaction.status)} · ${pretty(data.transaction.category)}`} />
            <Stat label="When" value={<span className="text-base">{when(data.transaction.createdAt)}</span>} sub={<span className="font-mono">{data.transaction.id}</span>} />
            <Stat label="From" value={<span className="text-base">{data.transaction.fromUser}</span>} sub={<span className="font-mono">{data.transaction.fromAccountNumber}</span>} />
            <Stat label="To" value={<span className="text-base">{data.transaction.fromAccountId === data.transaction.toAccountId ? "External / biller" : data.transaction.toUser}</span>}
              sub={data.transaction.description} />
          </div>
          <Section title="Ledger entries">
            <MiniTable rows={data.ledger} cols={[["Account", (r) => <span className="font-mono text-xs">{shortId(r.accountId)}</span>],
              ["Type", (r) => <Badge tone={r.type === "CREDIT" ? "green" : "red"}>{r.type.toLowerCase()}</Badge>], ["Amount", (r) => money(r.amount)], ["When", (r) => when(r.createdAt)]]} />
          </Section>
          <Section title="Attempts"><MiniTable rows={data.attempts} cols={attemptCols} /></Section>
        </>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2">
            <Stat label="Requested" value={money(data.attempt.amount)} sub={`${pretty(data.attempt.kind)} · ${data.attempt.target ?? ""}`} />
            <Stat label="Customer" value={<span className="text-base">{data.attempt.userName}</span>} sub={data.attempt.isSynthetic ? "synthetic test user" : data.attempt.userEmail} />
          </div>
          <Section title="Why it failed"><p className="text-sm">{data.attempt.errorMessage}</p></Section>
          <Section title="Attempt"><MiniTable rows={[data.attempt]} cols={attemptCols} /></Section>
        </>
      )}
    </Drawer>
  )
}

// ------------------------------------------------------------------ feedback

function Feedback() {
  const [rating, setRating] = useState("")
  const [outcome, setOutcome] = useState("")
  const [page, setPage] = useState(1)
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "feedback", rating, outcome, page],
    queryFn: () => adminApi.feedback({ rating, outcome, page, pageSize: 25 }),
    placeholderData: keepPreviousData
  })
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
        <div><label htmlFor="fb-r" className="label">Rating</label>
          <select id="fb-r" className="input" value={rating} onChange={(e) => { setRating(e.target.value); setPage(1) }}>
            <option value="">Any</option><option value="HAPPY">Happy</option><option value="SATISFIED">Satisfied</option>
            <option value="NOT_SATISFIED">Not satisfied</option><option value="DISMISSED">Dismissed</option>
          </select></div>
        <div><label htmlFor="fb-o" className="label">Transaction outcome</label>
          <select id="fb-o" className="input" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1) }}>
            <option value="">Any</option><option value="SUCCESS">Success</option><option value="FAILURE">Failure</option>
          </select></div>
      </div>
      {!data ? <QueryState isLoading={isLoading} error={error} /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900"><tr><Th>When</Th><Th>Customer</Th><Th>Rating</Th><Th>Comment</Th><Th>Transaction</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.items.map((f) => (
                  <tr key={f.id}>
                    <Td>{when(f.createdAt)}</Td>
                    <Td><div className="font-semibold">{f.userName}</div>{f.isSynthetic && <Badge tone="violet">synthetic</Badge>}</Td>
                    <Td><Badge tone={ratingTone(f.rating)}>{pretty(f.rating ?? f.status)}</Badge></Td>
                    <Td>{f.comment ? <span className="italic">“{f.comment}”</span> : "—"}</Td>
                    <Td>{pretty(f.kind)} · {money(f.amount)} <Badge tone={outcomeTone(f.outcome)}>{pretty(f.outcome)}</Badge>
                      {f.errorCategory && <div className="text-xs text-rose-600">{pretty(f.errorCategory)}</div>}</Td>
                  </tr>
                ))}
                {!data.items.length && <tr><Td>No feedback yet.</Td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ audit

function Audit() {
  const [page, setPage] = useState(1)
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "audit", page], queryFn: () => adminApi.audit({ page, pageSize: 30 }), placeholderData: keepPreviousData
  })
  if (!data) return <QueryState isLoading={isLoading} error={error} />
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900"><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Target</Th><Th>Details</Th><Th>IP</Th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.items.map((a) => (
              <tr key={a.id}>
                <Td>{when(a.createdAt)}</Td>
                <Td>{a.actor ?? "system / CLI"}<div className="text-xs text-slate-500">{a.actorEmail}</div></Td>
                <Td><Badge tone={a.eventType.includes("denied") ? "red" : "slate"}>{a.eventType}</Badge></Td>
                <Td mono>{a.entity ?? ""}{a.entityId ? ` ${shortId(a.entityId)}` : ""}</Td>
                <Td mono>{Object.keys(a.metadata || {}).length ? JSON.stringify(a.metadata) : ""}</Td>
                <Td mono>{a.ip ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
    </div>
  )
}
