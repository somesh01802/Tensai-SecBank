import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { LogoMark } from "@/components/Logo"
import { useAuthStore } from "@/stores/authStore"

const DURATION_MS = 6500

/**
 * Post-login premium splash — 5–10 seconds. Shown between login/MPIN
 * setup and the dashboard. Does NOT block authentication: the token
 * has already been issued at this point; this is a UX transition only.
 *
 * The route is only visited when the auth store's `justAuthed` flag
 * is set (see LoginPage / MpinSetupPage / RegisterPage). Direct visits
 * to /app/splash from other places skip to the dashboard immediately.
 */
export function SplashPage() {
  const navigate = useNavigate()
  const justAuthed = useAuthStore((s) => s.justAuthed)
  const clearJustAuthed = useAuthStore((s) => s.clearJustAuthed)
  const user = useAuthStore((s) => s.user)

  const [progress, setProgress] = useState(0)
  const startedAt = useRef(Date.now())

  useEffect(() => {
    if (!justAuthed) {
      navigate("/app", { replace: true })
      return
    }
    let raf = 0
    const tick = () => {
      const p = Math.min(1, (Date.now() - startedAt.current) / DURATION_MS)
      setProgress(p)
      if (p < 1) raf = requestAnimationFrame(tick)
      else {
        clearJustAuthed()
        navigate("/app", { replace: true })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [justAuthed, navigate, clearJustAuthed])

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-950 text-white">
      {/* Animated gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 15% 20%, rgba(58,99,255,.35), transparent 45%)," +
            "radial-gradient(circle at 85% 80%, rgba(140,90,255,.28), transparent 40%)," +
            "linear-gradient(135deg,#0a0e2e 0%,#0e1a3c 40%,#1a2fa0 100%)"
        }}
      />
      {/* Slow-moving orbs for depth */}
      <div aria-hidden className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-brand-500/25 blur-3xl" style={{ animation: "tsb-orb-a 9s ease-in-out infinite" }} />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 -right-40 h-[26rem] w-[26rem] rounded-full bg-purple-500/25 blur-3xl" style={{ animation: "tsb-orb-b 11s ease-in-out infinite" }} />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px),linear-gradient(90deg,#fff 1px, transparent 1px)", backgroundSize: "42px 42px" }} />

      {/* Center content */}
      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center px-6">
        <div className="relative">
          <div
            aria-hidden
            className="absolute inset-0 rounded-3xl blur-2xl"
            style={{ background: "radial-gradient(circle, rgba(244,200,106,.35), transparent 60%)" }}
          />
          <div className="relative rounded-3xl bg-white/5 p-6 backdrop-blur-sm ring-1 ring-white/10">
            <LogoMark size={88} />
          </div>
        </div>

        <div className="mt-8 flex items-baseline gap-2 text-3xl font-black tracking-tight">
          <span>Tensai</span>
          <span className="bg-gradient-to-r from-brand-300 to-white bg-clip-text text-transparent">SecBank</span>
        </div>
        <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.4em] text-white/50">
          Secure · Intelligent · Instant
        </div>

        {user?.name && (
          <div className="mt-6 text-sm text-white/80">
            Welcome back, <span className="font-semibold text-white">{user.name.split(" ")[0]}</span>
          </div>
        )}

        {/* Progress bar */}
        <div className="mt-8 h-1.5 w-64 max-w-[80vw] overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-400 via-brand-300 to-white shadow-[0_0_16px_rgba(58,99,255,.55)]"
            style={{ width: `${(progress * 100).toFixed(1)}%`, transition: "width 60ms linear" }}
          />
        </div>
        <div className="mt-3 text-[11px] uppercase tracking-widest text-white/50">
          {progress < 0.35 ? "Securing your session" : progress < 0.75 ? "Loading your accounts" : "Almost there"}
        </div>
      </div>

      <style>{`
        @keyframes tsb-orb-a { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(30px,20px) scale(1.08); } }
        @keyframes tsb-orb-b { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-30px,-15px) scale(1.1); } }
      `}</style>
    </div>
  )
}
