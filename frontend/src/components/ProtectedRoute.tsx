import { useEffect, useState } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useAuthStore } from "@/stores/authStore"
import { authV2 } from "@/api/v2"

export function ProtectedRoute({
  children,
  requireMpin = false
}: {
  children: React.ReactNode
  requireMpin?: boolean
}) {
  const token = useAuthStore((s) => s.token)
  const hasMpin = useAuthStore((s) => s.hasMpin)
  const setHasMpin = useAuthStore((s) => s.setHasMpin)
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN")
  const location = useLocation()
  const [checking, setChecking] = useState<boolean>(requireMpin && !hasMpin && !isAdmin)

  useEffect(() => {
    let cancelled = false
    async function verify() {
      if (!requireMpin || isAdmin) return
      if (hasMpin) return
      try {
        const v = await authV2.hasMpin()
        if (!cancelled) {
          setHasMpin(Boolean(v))
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    verify()
    return () => { cancelled = true }
  }, [requireMpin, hasMpin, setHasMpin, isAdmin])

  if (!token) return <Navigate to="/login" replace state={{ from: location }} />
  // Staff accounts have no customer banking area.
  if (isAdmin) return <Navigate to="/admin" replace />

  if (requireMpin) {
    if (checking) return null
    if (!hasMpin) return <Navigate to="/mpin-setup" replace />
  }

  return <>{children}</>
}

/** Admin console guard (UX only — the API enforces the ADMIN role on every /api/admin call). */
export function AdminRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token)
  const role = useAuthStore((s) => s.user?.role)
  if (!token) return <Navigate to="/login" replace />
  if (role !== "ADMIN") return <Navigate to="/app" replace />
  return <>{children}</>
}
