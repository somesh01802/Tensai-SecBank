import { Bell, CheckCheck, ExternalLink } from "lucide-react"
import { Link } from "react-router-dom"
import type { Notification } from "@/types/api"

export function NotificationDropdown({
  notifications,
  onClose,
  onRead,
  onReadAll
}: {
  notifications: Notification[]
  onClose: () => void
  onRead: (id: string) => void
  onReadAll: () => void
}) {
  const unread = notifications.filter((n) => !n.readAt)
  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-[360px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Bell className="h-4 w-4 text-brand-600" />
          Notifications
          <span className="text-xs font-normal text-slate-500">
            ({unread.length} unread)
          </span>
        </div>
        <button
          onClick={onReadAll}
          className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
        >
          <CheckCheck className="h-3 w-3" /> Mark all read
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">No notifications</div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {notifications.map((n) => (
              <li
                key={n.id}
                className={
                  "px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/50 " +
                  (!n.readAt ? "bg-brand-50/40 dark:bg-brand-500/5" : "")
                }
              >
                <div className="flex items-start gap-2">
                  <span
                    className={
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full " +
                      (n.readAt ? "bg-transparent" : "bg-brand-500")
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {n.title}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {n.body}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                      <span>{n.category}</span>
                      <span>·</span>
                      <span>{new Date(n.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                      {n.actionUrl && (
                        <>
                          <span>·</span>
                          <Link
                            to={n.actionUrl}
                            onClick={onClose}
                            className="flex items-center gap-0.5 font-semibold text-brand-600 hover:underline"
                          >
                            Open <ExternalLink className="h-2.5 w-2.5" />
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  {!n.readAt && (
                    <button
                      onClick={() => onRead(n.id)}
                      className="text-[11px] font-semibold text-brand-600 hover:underline"
                    >
                      Read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-slate-100 px-4 py-2 text-center dark:border-slate-800">
        <Link
          to="/app/notifications"
          onClick={onClose}
          className="text-xs font-semibold text-brand-600 hover:underline"
        >
          View all
        </Link>
      </div>
    </div>
  )
}
