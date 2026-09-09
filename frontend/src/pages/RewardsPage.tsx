import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Award, CheckCircle2, Trophy } from "lucide-react"
import { rewardsApi } from "@/api/v2"
import { cn } from "@/lib/utils"

export function RewardsPage() {
  useEffect(() => { rewardsApi.event("page.visited.rewards").catch(() => {}) }, [])

  const q = useQuery({ queryKey: ["rewards"], queryFn: rewardsApi.list })
  const [filter, setFilter] = useState<"ALL" | "COMPLETED" | "AVAILABLE">("ALL")
  const [category, setCategory] = useState<string>("ALL")

  const categories = useMemo(() => {
    if (!q.data) return []
    return Array.from(new Set(q.data.tasks.map((t) => t.category))).sort()
  }, [q.data])

  const filtered = useMemo(() => {
    if (!q.data) return []
    return q.data.tasks.filter((t) => {
      if (filter === "COMPLETED" && !t.completed) return false
      if (filter === "AVAILABLE" && t.completed) return false
      if (category !== "ALL" && t.category !== category) return false
      return true
    })
  }, [q.data, filter, category])

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Loyalty</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Rewards</h1>
        <p className="mt-1 text-sm text-slate-500">Complete tasks around Tensai SecBank to earn points.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Total points</div>
          <div className="mt-1 flex items-center gap-2 text-3xl font-black text-brand-600">
            <Trophy className="h-6 w-6" />
            {q.data?.summary.totalPoints ?? 0}
          </div>
        </div>
        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Completed</div>
          <div className="mt-1 flex items-center gap-2 text-3xl font-black text-emerald-600">
            <CheckCircle2 className="h-6 w-6" />
            {q.data?.summary.completedCount ?? 0}
          </div>
        </div>
        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Available</div>
          <div className="mt-1 flex items-center gap-2 text-3xl font-black text-slate-500">
            <Award className="h-6 w-6" />
            {q.data ? q.data.tasks.length - q.data.summary.completedCount : 0}
          </div>
        </div>
      </div>

      <div className="card flex flex-wrap items-center gap-2 p-3">
        {(["ALL","COMPLETED","AVAILABLE"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold",
              filter === k ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            )}
          >
            {k[0] + k.slice(1).toLowerCase()}
          </button>
        ))}
        <div className="mx-2 h-4 w-px bg-slate-200 dark:bg-slate-800" />
        <button
          onClick={() => setCategory("ALL")}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold",
            category === "ALL" ? "bg-slate-800 text-white dark:bg-white dark:text-slate-900" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          )}
        >
          All categories
        </button>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold",
              category === c ? "bg-slate-800 text-white dark:bg-white dark:text-slate-900" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[0,1,2,3].map((i) => <div key={i} className="skeleton h-24" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filtered.map((t) => (
            <div
              key={t.id}
              className={cn(
                "card flex items-start gap-3 p-4",
                t.completed && "opacity-75"
              )}
            >
              <div
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
                  t.completed
                    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300"
                )}
              >
                {t.completed ? <CheckCircle2 className="h-5 w-5" /> : <Award className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className={cn("font-semibold", t.completed && "line-through decoration-emerald-500/60")}>
                    {t.title}
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 dark:bg-slate-800">
                    {t.category}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t.description}</div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="font-mono">{t.code}</span>
                  {t.completedAt && (
                    <>
                      <span>·</span>
                      <span>Completed {new Date(t.completedAt).toLocaleDateString("en-IN")}</span>
                    </>
                  )}
                </div>
              </div>
              <div className={cn("shrink-0 text-lg font-black", t.completed ? "text-emerald-600" : "text-brand-600")}>
                +{t.points}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
