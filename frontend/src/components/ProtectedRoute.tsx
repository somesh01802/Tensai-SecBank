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
  const location = useLocation()
  const [checking, setChecking] = useState<boolean>(requireMpin && !hasMpin)

  useEffect(() => {
    let cancelled = false
    async function verify() {
      if (!requireMpin) return
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
  }, [requireMpin, hasMpin, setHasMpin])

  if (!token) return <Navigate to="/login" replace state={{ from: location }} />

  if (requireMpin) {
    if (checking) return null
    if (!hasMpin) return <Navigate to="/mpin-setup" replace />
  }

  return <>{children}</>
}
