import { Copy } from "lucide-react"
import toast from "react-hot-toast"

import type { Account } from "@/types/api"
import { AccountStatusBadge } from "./StatusBadge"
import { LogoMark } from "@/components/Logo"
import { formatCurrency, shortId } from "@/lib/utils"

export function AccountCard({ account, highlight }: { account: Account; highlight?: boolean }) {
  const copy = () => {
    navigator.clipboard.writeText(account.id).then(() => toast.success("Account ID copied"))
  }
  return (
    <div
      className={
        "group relative overflow-hidden rounded-2xl border p-5 text-white shadow-card transition-transform hover:-translate-y-0.5 " +
        (highlight
          ? "border-brand-400 bg-gradient-to-br from-brand-600 via-brand-700 to-slate-900"
          : "border-slate-800 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900")
      }
    >
      <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
      <div className="relative flex items-start justify-between">
        <div className="flex items-center gap-2">
          <LogoMark size={36} />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-white/60">
              {account.currency} Account
            </div>
            <div className="flex items-baseline gap-1 text-xs font-semibold text-white/90">
              <span>Tensai</span>
              <span className="text-brand-200">SecBank</span>
            </div>
          </div>
        </div>
        <AccountStatusBadge status={account.status} />
      </div>

      <div className="relative mt-6">
        <div className="text-[10px] uppercase tracking-widest text-white/60">Available balance</div>
        <div className="mt-1 text-3xl font-bold tracking-tight">
          {formatCurrency(account.balance, account.currency)}
        </div>
      </div>

      <div className="relative mt-5 flex items-center justify-between">
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2 py-1 font-mono text-[11px] text-white/70 backdrop-blur hover:bg-white/10 hover:text-white"
        >
          {shortId(account.id, 8, 6)}
          <Copy className="h-3 w-3" />
        </button>
        <div className="text-[11px] font-medium text-white/70">
          Opened {new Date(account.createdAt).toLocaleDateString("en-IN")}
        </div>
      </div>
    </div>
  )
}
