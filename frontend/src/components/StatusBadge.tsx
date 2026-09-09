import { CheckCircle2, Clock, XCircle, RefreshCcw, Snowflake, Ban, CircleDot } from "lucide-react"
import type { AccountStatus, TransactionStatus } from "@/types/api"
import { cn } from "@/lib/utils"

export function TxStatusBadge({ status }: { status: TransactionStatus }) {
  const map: Record<TransactionStatus, { icon: React.ReactNode; className: string; label: string }> = {
    COMPLETED: {
      icon: <CheckCircle2 className="h-3 w-3" />,
      className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
      label: "Completed"
    },
    PENDING: {
      icon: <Clock className="h-3 w-3 animate-pulse" />,
      className: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
      label: "Pending"
    },
    FAILED: {
      icon: <XCircle className="h-3 w-3" />,
      className: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
      label: "Failed"
    },
    REVERSED: {
      icon: <RefreshCcw className="h-3 w-3" />,
      className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
      label: "Reversed"
    }
  }
  const cfg = map[status]
  return (
    <span className={cn("badge", cfg.className)}>
      {cfg.icon}
      {cfg.label}
    </span>
  )
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const map: Record<AccountStatus, { icon: React.ReactNode; className: string; label: string }> = {
    ACTIVE: {
      icon: <CircleDot className="h-3 w-3" />,
      className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
      label: "Active"
    },
    FROZEN: {
      icon: <Snowflake className="h-3 w-3" />,
      className: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
      label: "Frozen"
    },
    CLOSED: {
      icon: <Ban className="h-3 w-3" />,
      className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
      label: "Closed"
    }
  }
  const cfg = map[status]
  return (
    <span className={cn("badge", cfg.className)}>
      {cfg.icon}
      {cfg.label}
    </span>
  )
}
