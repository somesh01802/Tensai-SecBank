import { NavLink } from "react-router-dom"
import {
  X,
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

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 w-72 bg-white p-4 dark:bg-slate-950">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LogoMark size={32} />
            <div className="flex items-baseline gap-1 text-sm font-extrabold tracking-tight">
              <span>Tensai</span>
              <span className="text-brand-600 dark:text-brand-400">SecBank</span>
            </div>
          </div>
          <button className="btn-ghost !p-2" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium",
                  isActive
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900"
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
    </div>
  )
}
