import { NavLink } from "react-router-dom"
import {
  LayoutDashboard,
  BarChart3,
  Landmark,
  TrendingUp,
  CreditCard,
  Receipt,
  ArrowLeftRight,
  Settings2,
  Trophy,
  Bell
} from "lucide-react"
import { cn } from "@/lib/utils"
import { LogoMark } from "@/components/Logo"

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/overview", label: "Overview", icon: BarChart3 },
  { to: "/app/manage-account", label: "Manage Account", icon: Settings2 },
  { to: "/app/loans", label: "Loans", icon: Landmark },
  { to: "/app/investments", label: "Investments", icon: TrendingUp },
  { to: "/app/cards", label: "Cards", icon: CreditCard },
  { to: "/app/bills", label: "Bills", icon: Receipt },
  { to: "/app/transfer", label: "Transfer", icon: ArrowLeftRight },
  { to: "/app/rewards", label: "Rewards", icon: Trophy },
  { to: "/app/notifications", label: "Notifications", icon: Bell }
]

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 lg:flex">
      <div className="flex h-16 items-center gap-2.5 px-6">
        <LogoMark size={36} />
        <div className="leading-tight">
          <div className="flex items-baseline gap-1">
            <span className="text-[13px] font-extrabold tracking-tight text-slate-900 dark:text-white">
              Tensai
            </span>
            <span className="text-[13px] font-extrabold tracking-tight text-brand-600 dark:text-brand-400">
              SecBank
            </span>
          </div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400">
            Secure · Intelligent
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                isActive
                  ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100"
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded-lg transition",
                    isActive
                      ? "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
                      : "text-slate-400"
                  )}
                >
                  <item.icon className="h-[16px] w-[16px]" strokeWidth={2} />
                </span>
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="px-4 pb-6">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-orange-100 via-orange-50 to-white p-4 dark:from-orange-500/15 dark:via-orange-500/5 dark:to-transparent">
          <div className="pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full bg-orange-300/50 blur-2xl" />
          <div className="text-lg font-black text-slate-900 dark:text-slate-100">100%</div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300">
            Paperless Digital Loan
          </div>
          <div className="mt-1 text-[10px] text-slate-500">Get instant and quick approval</div>
          <NavLink
            to="/app/loans"
            className="mt-3 inline-flex rounded-full bg-orange-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-orange-600"
          >
            Apply now
          </NavLink>
        </div>
      </div>
    </aside>
  )
}
