import { useEffect, useMemo, useRef, useState } from "react"
import { Bell, LogOut, Menu, Moon, Search, Sun } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import toast from "react-hot-toast"

import { useAuthStore } from "@/stores/authStore"
import { useThemeStore } from "@/stores/themeStore"
import { authApi } from "@/api/auth"
import { notificationsApi, rewardsApi } from "@/api/v2"
import { MobileSidebar } from "./MobileSidebar"
import { NotificationDropdown } from "./NotificationDropdown"

const SEARCH_HINTS = [
  "Search for 'Personal Loan'",
  "Search for 'Gold Loan'",
  "Search for 'Fixed Deposit'",
  "Search for 'Saving Account'",
  "Search for 'Credit Card'",
  "Search for 'Car Loan'",
  "Search for 'Home Loan'"
]

export function TopBar() {
  const user = useAuthStore((s) => s.user)
  const clear = useAuthStore((s) => s.clear)
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const [notifOpen, setNotifOpen] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notifRef = useRef<HTMLDivElement>(null)

  // Cycle placeholder
  useEffect(() => {
    if (query) return  // Pause cycling when user is typing
    const t = setInterval(() => setPlaceholderIdx((v) => (v + 1) % SEARCH_HINTS.length), 2200)
    return () => clearInterval(t)
  }, [query])

  // Notifications
  const notifQ = useQuery({
    queryKey: ["notifications"],
    queryFn: notificationsApi.list,
    refetchInterval: 30_000
  })

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  async function handleLogout() {
    try { await authApi.logout() } catch { /* ignore */ }
    clear()
    toast.success("Signed out")
    navigate("/login")
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return
    rewardsApi.event("ui.search.used").catch(() => {})
    rewardsApi.event("ui.search.product").catch(() => {})
    navigate(`/app/transactions?q=${encodeURIComponent(query.trim())}`)
  }

  const initials = useMemo(() => {
    if (!user?.name) return "U"
    return user.name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase()
  }, [user])

  return (
    <>
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/90 sm:px-6 lg:px-8">
        <button
          className="btn-ghost !p-2 lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <form onSubmit={submitSearch} className="min-w-0 flex-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full rounded-full border border-slate-200 bg-slate-50 py-2.5 pl-11 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
              placeholder={SEARCH_HINTS[placeholderIdx]}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </form>

        <div className="flex items-center gap-2">
          <div ref={notifRef} className="relative">
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
              title="Notifications"
            >
              <Bell className="h-4 w-4" />
              {notifQ.data && notifQ.data.unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                  {notifQ.data.unreadCount > 9 ? "9+" : notifQ.data.unreadCount}
                </span>
              )}
            </button>
            {notifOpen && (
              <NotificationDropdown
                notifications={notifQ.data?.notifications ?? []}
                onClose={() => setNotifOpen(false)}
                onRead={async (id) => {
                  await notificationsApi.markRead(id)
                  queryClient.invalidateQueries({ queryKey: ["notifications"] })
                }}
                onReadAll={async () => {
                  await notificationsApi.markAllRead()
                  queryClient.invalidateQueries({ queryKey: ["notifications"] })
                }}
              />
            )}
          </div>

          <button
            onClick={toggleTheme}
            className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            title="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <button
            onClick={handleLogout}
            className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 hover:text-rose-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>

          <Link to="/app/settings" className="ml-1 flex items-center gap-2 rounded-full px-1.5 py-1.5 pr-3 hover:bg-slate-50 dark:hover:bg-slate-900">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white">
              {initials}
            </span>
            <span className="hidden text-sm font-semibold sm:inline">{user?.name}</span>
          </Link>
        </div>
      </header>

      <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  )
}
