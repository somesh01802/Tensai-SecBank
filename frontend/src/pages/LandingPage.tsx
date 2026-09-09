import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Phone,
  Search,
  Menu,
  X,
  ShieldCheck,
  Zap,
  Landmark,
  CreditCard,
  Wallet,
  PiggyBank,
  LineChart,
  Home,
  Car,
  GraduationCap,
  HeartHandshake,
  Users,
  Lock,
  Sparkles,
  Play,
  Star
} from "lucide-react"

import { LogoMark } from "@/components/Logo"
import { cn } from "@/lib/utils"

/**
 * Public marketing site. Structure loosely inspired by ICICI's homepage:
 *  - Utility bar (phone, quick nav)
 *  - Sticky primary header (logo, mega menu, login)
 *  - Segment tabs (Personal / Business / NRI / Corporate)
 *  - Hero carousel with rotating promo slides
 *  - Product tile grid (Accounts / Deposits / Loans / Cards / Invest)
 *  - Trust indicators (numbers, awards)
 *  - App download strip
 *  - Footer
 *
 * Kept our Tensai SecBank blue instead of ICICI orange (per brand direction).
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <UtilityBar />
      <PrimaryHeader />
      <SegmentTabs />
      <HeroCarousel />
      <ProductTiles />
      <PromoStrip />
      <TrustSection />
      <AppDownload />
      <Footer />
    </div>
  )
}

/* ------------------------------ Header layers ----------------------------- */

function UtilityBar() {
  return (
    <div className="hidden border-b border-slate-100 bg-slate-50 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 lg:block">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6">
        <a href="tel:1800-000-000" className="flex items-center gap-1.5 hover:text-brand-600">
          <Phone className="h-3 w-3" /> 1800 000 000
        </a>
        <span className="text-slate-300 dark:text-slate-700">·</span>
        <a className="hover:text-brand-600" href="#">Locate a branch</a>
        <a className="hover:text-brand-600" href="#">Rates & charges</a>
        <a className="hover:text-brand-600" href="#">Customer care</a>
        <div className="ml-auto flex items-center gap-4">
          <a className="hover:text-brand-600" href="#">About us</a>
          <a className="hover:text-brand-600" href="#">Careers</a>
          <a className="hover:text-brand-600" href="#">Investor relations</a>
          <a className="hover:text-brand-600" href="#">EN ▾</a>
        </div>
      </div>
    </div>
  )
}

function PrimaryHeader() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  return (
    <header className="sticky top-0 z-40 border-b border-slate-100 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:gap-8">
        <Link to="/" className="flex items-center gap-2">
          <LogoMark size={40} />
          <div className="leading-tight">
            <div className="flex items-baseline gap-1">
              <span className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white">
                Tensai
              </span>
              <span className="text-base font-extrabold tracking-tight text-brand-600 dark:text-brand-400">
                SecBank
              </span>
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              Secure · Intelligent · Instant
            </div>
          </div>
        </Link>

        <nav className="ml-6 hidden items-center gap-1 lg:flex">
          {MENUS.map((m) => (
            <MegaMenuTrigger
              key={m.title}
              menu={m}
              open={openMenu === m.title}
              onEnter={() => setOpenMenu(m.title)}
              onLeave={() => setOpenMenu(null)}
            />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button className="hidden rounded-full border border-slate-200 bg-white p-2 text-slate-500 hover:text-slate-800 dark:border-slate-800 dark:bg-slate-900 lg:inline-flex">
            <Search className="h-4 w-4" />
          </button>
          <Link
            to="/login"
            className="hidden rounded-full border border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-brand-700 shadow-sm hover:bg-brand-50 dark:border-brand-500/30 dark:bg-transparent dark:text-brand-300 dark:hover:bg-brand-500/10 sm:inline-flex"
          >
            Log in
          </Link>
          <Link
            to="/register"
            className="hidden rounded-full bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:brightness-110 sm:inline-flex"
          >
            Open account →
          </Link>

          <button
            className="rounded-full border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>
      </div>

      {mobileOpen && <MobilePublicNav onClose={() => setMobileOpen(false)} />}
    </header>
  )
}

function MegaMenuTrigger({
  menu,
  open,
  onEnter,
  onLeave
}: {
  menu: typeof MENUS[number]
  open: boolean
  onEnter: () => void
  onLeave: () => void
}) {
  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        className={cn(
          "flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold transition",
          open
            ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            : "text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
        )}
      >
        {menu.title}
        <ChevronDown className={cn("h-3.5 w-3.5 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-1/2 top-full z-40 w-[720px] -translate-x-1/2 pt-2">
          <div className="grid grid-cols-3 gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-900/10 dark:border-slate-800 dark:bg-slate-900">
            {menu.groups.map((g) => (
              <div key={g.title}>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-brand-600 dark:text-brand-400">
                  {g.title}
                </div>
                <ul className="space-y-1">
                  {g.items.map((it) => (
                    <li key={it}>
                      <a
                        href="#"
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-brand-300"
                      >
                        <ChevronRight className="h-3 w-3 opacity-50" />
                        {it}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MobilePublicNav({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-slate-950/60" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-80 max-w-full overflow-y-auto bg-white p-4 dark:bg-slate-950">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LogoMark size={30} />
            <div className="text-sm font-extrabold">Tensai SecBank</div>
          </div>
          <button onClick={onClose} className="rounded-full p-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4">
          {MENUS.map((m) => (
            <details key={m.title} className="rounded-xl border border-slate-100 dark:border-slate-800">
              <summary className="cursor-pointer list-none px-3 py-2 text-sm font-semibold">
                {m.title}
              </summary>
              <div className="space-y-2 px-3 pb-3">
                {m.groups.map((g) => (
                  <div key={g.title}>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-brand-600">
                      {g.title}
                    </div>
                    <ul className="mt-1 space-y-0.5 text-sm text-slate-600 dark:text-slate-400">
                      {g.items.map((i) => (
                        <li key={i}>
                          <a href="#" className="block py-0.5">
                            {i}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          ))}
          <div className="grid grid-cols-2 gap-2 pt-4">
            <Link to="/login" onClick={onClose} className="btn-secondary">
              Log in
            </Link>
            <Link to="/register" onClick={onClose} className="btn-primary">
              Open account
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

const MENUS = [
  {
    title: "Personal",
    groups: [
      {
        title: "Accounts",
        items: ["Savings account", "Salary account", "Youth account", "Senior citizen"]
      },
      {
        title: "Deposits",
        items: ["Fixed deposits", "Recurring deposits", "Tax saver FD", "SweepIn"]
      },
      {
        title: "Loans",
        items: ["Home loan", "Car loan", "Personal loan", "Education loan"]
      },
      {
        title: "Cards",
        items: ["Credit cards", "Debit cards", "Travel cards", "Rewards"]
      },
      {
        title: "Invest",
        items: ["Mutual funds", "SIP", "Demat & trading", "PMS"]
      },
      {
        title: "Insure",
        items: ["Life", "Health", "Motor", "Home"]
      }
    ]
  },
  {
    title: "Business",
    groups: [
      { title: "Current accounts", items: ["Roaming current", "Trade current", "Startup account"] },
      { title: "Business loans", items: ["Working capital", "Term loan", "MSME express"] },
      { title: "Trade & FX", items: ["Import/Export", "Forex cards", "Remittance"] }
    ]
  },
  {
    title: "NRI",
    groups: [
      { title: "Accounts", items: ["NRE", "NRO", "FCNR(B)"] },
      { title: "Money transfer", items: ["Money2India", "Wire transfer", "Cheque"] }
    ]
  },
  {
    title: "Wealth",
    groups: [
      { title: "Wealth management", items: ["Private banking", "Portfolio advisory", "Estate planning"] },
      { title: "Global markets", items: ["Fixed income", "Structured products"] }
    ]
  }
]

/* -------------------------------- Segment -------------------------------- */

function SegmentTabs() {
  const tabs = ["Personal", "Business", "NRI", "Corporate", "Wealth"]
  const [active, setActive] = useState(0)
  return (
    <div className="hidden border-b border-slate-100 dark:border-slate-800 lg:block">
      <div className="mx-auto flex max-w-7xl items-center gap-1 px-6 py-2">
        {tabs.map((t, i) => (
          <button
            key={t}
            onClick={() => setActive(i)}
            className={cn(
              "rounded-full px-4 py-1.5 text-xs font-semibold transition",
              active === i
                ? "bg-brand-600 text-white shadow-sm shadow-brand-600/30"
                : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            )}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------- Hero --------------------------------- */

const SLIDES = [
  {
    eyebrow: "New this week",
    title: "Home upgrades, healthcare, holidays.",
    highlight: "Your goals, one loan.",
    body: "Personal loans up to ₹40L at industry-best rates. Zero paperwork, instant approval.",
    cta: "Apply now",
    ctaHref: "/register",
    art: <HeroArtCards />
  },
  {
    eyebrow: "Zero balance",
    title: "Open a Tensai savings account in",
    highlight: "under 3 minutes.",
    body: "Full-featured KYC-lite savings with a virtual RuPay debit card and UPI on day one.",
    cta: "Open account",
    ctaHref: "/register",
    art: <HeroArtSavings />
  },
  {
    eyebrow: "Reimagined",
    title: "Your money, in every language",
    highlight: "of numbers.",
    body: "Live balances, category-level spend analytics, and one-click salary allocation.",
    cta: "See the app",
    ctaHref: "/register",
    art: <HeroArtAnalytics />
  }
]

function HeroCarousel() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % SLIDES.length), 6000)
    return () => clearInterval(t)
  }, [])
  const slide = SLIDES[i]
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-brand-50 via-white to-white dark:from-brand-500/10 dark:via-slate-950 dark:to-slate-950">
      <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-brand-500/10 blur-3xl" />
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-16 sm:px-6 md:grid-cols-2 md:py-24 lg:px-8">
        <div className="flex flex-col justify-center">
          <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-brand-200 bg-white/70 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand-700 backdrop-blur dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
            <Sparkles className="h-3 w-3" />
            {slide.eyebrow}
          </div>
          <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
            {slide.title}{" "}
            <span className="bg-gradient-to-r from-brand-600 to-brand-800 bg-clip-text text-transparent">
              {slide.highlight}
            </span>
          </h1>
          <p className="mt-4 max-w-lg text-lg text-slate-600 dark:text-slate-400">
            {slide.body}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to={slide.ctaHref}
              className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-600 to-brand-700 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-brand-600/40 hover:brightness-110"
            >
              {slide.cta}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <button className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3 text-sm font-bold text-slate-700 hover:border-brand-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
              <Play className="h-3.5 w-3.5" /> Watch how it works
            </button>
          </div>
          <div className="mt-8 flex items-center gap-2">
            {SLIDES.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setI(idx)}
                aria-label={`Slide ${idx + 1}`}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  idx === i ? "w-8 bg-brand-600" : "w-2 bg-slate-300 dark:bg-slate-700"
                )}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center justify-center">{slide.art}</div>
      </div>
    </section>
  )
}

function HeroArtCards() {
  return (
    <div className="relative h-72 w-full max-w-md">
      <div className="absolute inset-x-6 top-6 h-44 rotate-[-6deg] rounded-2xl bg-gradient-to-br from-slate-800 to-slate-950 p-5 text-white shadow-2xl">
        <div className="flex items-center gap-2 text-xs opacity-70">
          <LogoMark size={22} /> Tensai · Platinum
        </div>
        <div className="mt-8 font-mono text-sm tracking-widest opacity-80">
          •••• •••• •••• 4291
        </div>
        <div className="mt-3 flex items-end justify-between text-[10px] uppercase tracking-widest opacity-60">
          <div>
            <div>Cardholder</div>
            <div className="mt-1 text-sm normal-case tracking-normal opacity-100">Aisha S.</div>
          </div>
          <div>
            <div>Expiry</div>
            <div className="mt-1 text-sm normal-case tracking-normal opacity-100">12/29</div>
          </div>
        </div>
      </div>
      <div className="absolute inset-x-2 top-24 h-44 rotate-[3deg] rounded-2xl bg-gradient-to-br from-brand-500 to-brand-800 p-5 text-white shadow-2xl">
        <div className="flex items-center gap-2 text-xs">
          <LogoMark size={22} /> Tensai · Everyday
        </div>
        <div className="mt-8 font-mono text-sm tracking-widest opacity-90">
          •••• •••• •••• 7710
        </div>
        <div className="mt-3 flex items-end justify-between text-[10px] uppercase tracking-widest opacity-80">
          <div>
            <div>Cardholder</div>
            <div className="mt-1 text-sm normal-case tracking-normal opacity-100">Rohan K.</div>
          </div>
          <div>
            <div>Expiry</div>
            <div className="mt-1 text-sm normal-case tracking-normal opacity-100">04/28</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function HeroArtSavings() {
  return (
    <div className="relative h-72 w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Available balance
          </div>
          <div className="mt-1 text-3xl font-extrabold">₹ 1,24,530.00</div>
        </div>
        <div className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          Active
        </div>
      </div>
      <div className="mt-6 grid grid-cols-3 gap-2 text-center">
        {["Send", "Receive", "Bills"].map((l) => (
          <div key={l} className="rounded-2xl bg-slate-50 py-4 text-xs font-semibold dark:bg-slate-800">
            {l}
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {[
          { name: "Salary", amt: "+ ₹ 85,000.00", positive: true },
          { name: "Landlord — Rent", amt: "− ₹ 25,000.00", positive: false },
          { name: "Zomato", amt: "− ₹ 640.00", positive: false }
        ].map((r) => (
          <div key={r.name} className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2 text-sm dark:border-slate-800">
            <span>{r.name}</span>
            <span className={r.positive ? "text-emerald-600 font-semibold" : "font-semibold"}>
              {r.amt}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HeroArtAnalytics() {
  const bars = [30, 55, 40, 70, 45, 85, 60, 95, 70, 80]
  return (
    <div className="relative h-72 w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            This month
          </div>
          <div className="mt-1 text-2xl font-extrabold">₹ 42,180 <span className="text-sm font-medium text-emerald-600">↑ 8%</span></div>
        </div>
        <LineChart className="h-6 w-6 text-brand-600" />
      </div>
      <div className="mt-6 flex h-32 items-end gap-2">
        {bars.map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-md bg-gradient-to-t from-brand-200 to-brand-600 dark:from-brand-500/30 dark:to-brand-400"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
        <span>Food · 24%</span>
        <span>Rent · 34%</span>
        <span>Save · 22%</span>
      </div>
    </div>
  )
}

/* --------------------------- Product tiles grid --------------------------- */

const PRODUCTS = [
  { icon: Wallet, title: "Savings account", body: "Zero-balance, virtual RuPay, UPI ready.", tag: "Popular" },
  { icon: PiggyBank, title: "Fixed deposits", body: "Up to 7.35% p.a. Monthly interest option.", tag: "New rates" },
  { icon: CreditCard, title: "Credit cards", body: "Cashback, travel, and premium ranges.", tag: "" },
  { icon: Home, title: "Home loan", body: "8.60% p.a. onward · Balance transfer offer.", tag: "" },
  { icon: Car, title: "Car loan", body: "Instant approval · Up to 100% funding.", tag: "" },
  { icon: GraduationCap, title: "Education loan", body: "Study abroad or in India · Moratorium.", tag: "" },
  { icon: LineChart, title: "Mutual funds & SIP", body: "Start SIPs from ₹500. Zero commission.", tag: "" },
  { icon: HeartHandshake, title: "Insurance", body: "Health, term, motor, home — all in one app.", tag: "" }
]

function ProductTiles() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24 lg:px-8">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-brand-600">
            Products
          </div>
          <h2 className="mt-1 text-3xl font-extrabold tracking-tight md:text-4xl">
            Made for every kind of money moment.
          </h2>
        </div>
        <a href="#" className="hidden text-sm font-semibold text-brand-600 hover:underline sm:inline">
          Explore all products →
        </a>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PRODUCTS.map((p) => (
          <div
            key={p.title}
            className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900 dark:hover:border-brand-500/40"
          >
            {p.tag && (
              <span className="absolute right-4 top-4 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                {p.tag}
              </span>
            )}
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-md shadow-brand-600/30">
              <p.icon className="h-5 w-5" />
            </div>
            <div className="mt-4 text-base font-bold">{p.title}</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {p.body}
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-brand-600">
              Apply
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* -------------------------------- Promo ---------------------------------- */

function PromoStrip() {
  return (
    <section className="border-y border-slate-100 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
        {[
          { icon: ShieldCheck, title: "RBI regulated", body: "Deposits insured up to ₹5L per DICGC." },
          { icon: Lock, title: "256-bit encryption", body: "End-to-end at rest and in transit." },
          { icon: Zap, title: "Instant transfers", body: "IMPS, UPI, and P2P in seconds." },
          { icon: Users, title: "4.6M+ customers", body: "Rated 4.7★ on the App Store." }
        ].map((c) => (
          <div key={c.title} className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-brand-600 shadow dark:bg-slate-800">
              <c.icon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-bold">{c.title}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{c.body}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ------------------------------ Trust ------------------------------------ */

function TrustSection() {
  const stats = [
    { n: "4.6M+", l: "Active customers" },
    { n: "₹ 82,000 Cr", l: "Assets under management" },
    { n: "1,240", l: "Branches nationwide" },
    { n: "99.99%", l: "Uptime · 12-month rolling" }
  ]
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-2">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-brand-600">
            Trusted at scale
          </div>
          <h2 className="mt-1 text-3xl font-extrabold tracking-tight md:text-4xl">
            Built like a bank. Feels like an app.
          </h2>
          <p className="mt-4 max-w-lg text-slate-500 dark:text-slate-400">
            Every rupee that flows through Tensai SecBank rides an immutable
            double-entry ledger with idempotent transfers. Real ACID — not "eventually correct."
          </p>
          <div className="mt-6 flex items-center gap-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Star key={i} className="h-5 w-5 fill-amber-400 text-amber-400" />
            ))}
            <span className="text-sm text-slate-500">4.7 · 122k reviews</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 self-center">
          {stats.map((s) => (
            <div key={s.l}>
              <div className="text-3xl font-extrabold text-brand-600 md:text-4xl">
                {s.n}
              </div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-widest text-slate-500">
                {s.l}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* --------------------------- App download strip -------------------------- */

function AppDownload() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-slate-950 text-white">
      <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 md:grid-cols-2 md:items-center lg:px-8">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-brand-200">
            iOS · Android · Web
          </div>
          <h2 className="mt-2 text-3xl font-extrabold md:text-4xl">
            Your bank fits in your pocket.
          </h2>
          <p className="mt-3 max-w-md text-brand-100">
            Send, save, and grow — anywhere. Biometric login, spend controls,
            and a card you can freeze with one tap.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <StoreButton store="apple" />
            <StoreButton store="google" />
          </div>
        </div>
        <div className="hidden justify-end md:flex">
          <PhoneMock />
        </div>
      </div>
    </section>
  )
}

function StoreButton({ store }: { store: "apple" | "google" }) {
  return (
    <a
      href="#"
      className="inline-flex items-center gap-3 rounded-2xl bg-black px-4 py-3 text-white shadow-lg hover:brightness-110"
    >
      <div className="text-2xl leading-none">{store === "apple" ? "" : "▶"}</div>
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-widest opacity-70">
          {store === "apple" ? "Download on the" : "Get it on"}
        </div>
        <div className="text-base font-bold">
          {store === "apple" ? "App Store" : "Google Play"}
        </div>
      </div>
    </a>
  )
}

function PhoneMock() {
  return (
    <div className="relative h-96 w-52 rounded-[3rem] border-4 border-slate-800 bg-slate-950 p-2 shadow-2xl">
      <div className="h-full w-full overflow-hidden rounded-[2.5rem] bg-gradient-to-br from-slate-950 via-slate-900 to-brand-950">
        <div className="p-4">
          <div className="flex items-center justify-between text-[10px] text-white/60">
            <span>9:41</span>
            <span>••• 5G</span>
          </div>
          <div className="mt-6 flex items-center gap-2 text-white">
            <LogoMark size={24} />
            <div className="text-xs font-bold">Tensai SecBank</div>
          </div>
          <div className="mt-5 text-[10px] font-bold uppercase tracking-widest text-white/50">
            Available
          </div>
          <div className="mt-1 text-2xl font-extrabold text-white">₹ 1,24,530</div>
          <div className="mt-4 grid grid-cols-3 gap-1 text-center text-[9px] font-semibold text-white/80">
            {["Send", "Pay", "Save"].map((l) => (
              <div key={l} className="rounded-lg bg-white/10 py-2 backdrop-blur">
                {l}
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-1.5">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-6 rounded bg-white/5" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------- Footer --------------------------------- */

function Footer() {
  const cols = [
    {
      title: "Personal",
      items: ["Accounts", "Deposits", "Loans", "Cards", "Invest", "Insure"]
    },
    {
      title: "Business",
      items: ["Current accounts", "Trade & FX", "Business loans", "POS", "APIs"]
    },
    {
      title: "About",
      items: ["Our story", "Careers", "Press", "Investor relations", "ESG"]
    },
    {
      title: "Support",
      items: ["Help center", "Contact", "Complaints", "Rates & fees", "Security"]
    }
  ]
  return (
    <footer className="border-t border-slate-100 bg-white text-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-6">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2">
              <LogoMark size={36} />
              <div className="leading-tight">
                <div className="flex items-baseline gap-1 text-base font-extrabold">
                  <span>Tensai</span>
                  <span className="text-brand-600">SecBank</span>
                </div>
                <div className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Secure · Intelligent · Instant
                </div>
              </div>
            </div>
            <p className="mt-4 max-w-xs text-slate-500 dark:text-slate-400">
              A modern, ledger-first bank. RBI regulated. Deposits insured under DICGC.
            </p>
            <div className="mt-6 flex items-center gap-3 text-slate-500">
              <Landmark className="h-4 w-4" />
              <span className="text-xs">Registered office · Mumbai, India</span>
            </div>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {c.title}
              </div>
              <ul className="space-y-2 text-slate-600 dark:text-slate-400">
                {c.items.map((i) => (
                  <li key={i}>
                    <a href="#" className="hover:text-brand-600">
                      {i}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-6 text-xs text-slate-500 dark:border-slate-800">
          <div>© {new Date().getFullYear()} Tensai SecBank. All rights reserved. Illustrative demo — not a real financial institution.</div>
          <div className="flex items-center gap-4">
            <a href="#" className="hover:text-brand-600">Privacy</a>
            <a href="#" className="hover:text-brand-600">Terms</a>
            <a href="#" className="hover:text-brand-600">Cookies</a>
            <a href="#" className="hover:text-brand-600">Accessibility</a>
          </div>
        </div>
      </div>
    </footer>
  )
}
