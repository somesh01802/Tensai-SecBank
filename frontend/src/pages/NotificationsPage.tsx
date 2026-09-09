import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, CheckCheck } from "lucide-react"
import { Link } from "react-router-dom"

import { notificationsApi, rewardsApi } from "@/api/v2"

export function NotificationsPage() {
  useEffect(() => { rewardsApi.event("page.visited.notifications").catch(() => {}) }, [])
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ["notifications"], queryFn: notificationsApi.list })
  const readOne = useMutation({
    mutationFn: notificationsApi.markRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] })
  })
  const readAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] })
  })

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Inbox</div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Notifications</h1>
        </div>
        <button
          className="btn-secondary"
          onClick={() => readAll.mutate()}
          disabled={readAll.isPending}
        >
          <CheckCheck className="h-4 w-4" /> Mark all read
        </button>
      </div>

      {q.isLoading ? (
        <div className="card p-5">
          {[0,1,2,3].map((i) => <div key={i} className="skeleton mb-2 h-14" />)}
        </div>
      ) : (q.data?.notifications.length ?? 0) === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          <Bell className="mx-auto mb-3 h-6 w-6" />
          No notifications
        </div>
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {q.data!.notifications.map((n) => (
            <div key={n.id} className={"flex items-start gap-3 px-5 py-4 " + (!n.readAt ? "bg-brand-50/40 dark:bg-brand-500/5" : "")}>
              <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (n.readAt ? "bg-transparent" : "bg-brand-500")} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{n.title}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">{n.body}</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {n.category} · {new Date(n.createdAt).toLocaleString("en-IN")}
                </div>
                {n.actionUrl && (
                  <Link to={n.actionUrl} className="mt-2 inline-block text-xs font-semibold text-brand-600 hover:underline">
                    Open →
                  </Link>
                )}
              </div>
              {!n.readAt && (
                <button
                  className="text-xs font-semibold text-brand-600 hover:underline"
                  onClick={() => readOne.mutate(n.id)}
                >
                  Mark read
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
