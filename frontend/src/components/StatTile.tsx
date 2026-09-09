import { cn } from "@/lib/utils"

export function StatTile({
  label,
  value,
  hint,
  icon,
  accent = "brand"
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon: React.ReactNode
  accent?: "brand" | "emerald" | "amber" | "rose"
}) {
  const accents: Record<string, string> = {
    brand: "from-brand-500/15 to-brand-500/0 text-brand-600 dark:text-brand-300",
    emerald: "from-emerald-500/15 to-emerald-500/0 text-emerald-600 dark:text-emerald-300",
    amber: "from-amber-500/15 to-amber-500/0 text-amber-600 dark:text-amber-300",
    rose: "from-rose-500/15 to-rose-500/0 text-rose-600 dark:text-rose-300"
  }
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
          {label}
        </div>
        <div className={cn("grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br", accents[accent])}>
          {icon}
        </div>
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>
      )}
    </div>
  )
}
