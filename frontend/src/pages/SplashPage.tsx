import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useAuthStore } from "@/stores/authStore"

const DURATION_MS = 6800

/**
 * Post-login premium splash — an iridescent glass-orb animation on a
 * near-black backdrop with subtle light rays and TSB branding.
 *
 * Fires on every successful authentication event (fresh registration,
 * password login, or MPIN login) — the auth store's `justAuthed`
 * flag is set by `setAuth`, which is called by every auth flow.
 *
 * If a user visits /splash directly without a fresh auth event,
 * we bounce to /app immediately so it never blocks navigation.
 */
export function SplashPage() {
  const navigate = useNavigate()
  const justAuthed = useAuthStore((s) => s.justAuthed)
  const clearJustAuthed = useAuthStore((s) => s.clearJustAuthed)
  const user = useAuthStore((s) => s.user)

  // Compute progress so the "Loading…" phase feels alive.
  const [progress, setProgress] = useState(0)
  const start = useMemo(() => Date.now(), [])

  useEffect(() => {
    if (!justAuthed) {
      navigate("/app", { replace: true })
      return
    }
    let raf = 0
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / DURATION_MS)
      setProgress(p)
      if (p < 1) raf = requestAnimationFrame(tick)
      else {
        clearJustAuthed()
        navigate("/app", { replace: true })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [justAuthed, navigate, clearJustAuthed, start])

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[#050510] text-white">
      {/* Deep radial glow behind everything */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 50%, rgba(45,70,180,.28) 0%, rgba(80,40,160,.14) 24%, rgba(0,0,0,0) 55%)"
        }}
      />

      {/* Faint sunburst light rays */}
      <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
        <div
          className="h-[520px] w-[520px] opacity-25"
          style={{
            animation: "tsb-rays 40s linear infinite",
            background:
              "conic-gradient(from 0deg," +
              "transparent 0deg,rgba(180,190,255,.35) 8deg,transparent 16deg," +
              "transparent 60deg,rgba(220,160,255,.28) 68deg,transparent 76deg," +
              "transparent 130deg,rgba(140,200,255,.32) 138deg,transparent 146deg," +
              "transparent 200deg,rgba(200,170,255,.28) 208deg,transparent 216deg," +
              "transparent 270deg,rgba(160,190,255,.32) 278deg,transparent 286deg," +
              "transparent 330deg,rgba(220,170,255,.26) 338deg,transparent 346deg,transparent 360deg)",
            filter: "blur(6px)",
            maskImage: "radial-gradient(circle,rgba(0,0,0,1) 30%,rgba(0,0,0,0) 70%)",
            WebkitMaskImage: "radial-gradient(circle,rgba(0,0,0,1) 30%,rgba(0,0,0,0) 70%)"
          }}
        />
      </div>

      {/* Center content */}
      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center px-6">
        {/* TSB wordmark, small + subtle at the top */}
        <div className="absolute top-10 left-1/2 -translate-x-1/2 text-center">
          <div className="flex items-baseline justify-center gap-1">
            <span className="text-[13px] font-black tracking-tight text-white/85">Tensai</span>
            <span className="text-[13px] font-black tracking-tight text-brand-300">SecBank</span>
          </div>
          <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.38em] text-white/40">
            TSB · Secure · Intelligent · Instant
          </div>
        </div>

        {/* The iridescent orb */}
        <div className="relative grid h-72 w-72 place-items-center sm:h-80 sm:w-80">
          {/* Outer bloom */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-[-40px]"
            style={{
              background:
                "radial-gradient(circle,rgba(120,140,255,.30) 0%,rgba(120,140,255,0) 60%)",
              animation: "tsb-bloom 3.6s ease-in-out infinite"
            }}
          />

          {/* Glass sphere: layered blurred blobs with mix-blend-lighten */}
          <div className="relative h-full w-full">
            <Blob
              hue="180 90% 60%"
              size={82}
              offsetX={-8}
              offsetY={-6}
              blur={22}
              opacity={0.55}
              delay={0}
              duration={9}
            />
            <Blob
              hue="220 90% 65%"
              size={90}
              offsetX={12}
              offsetY={-3}
              blur={26}
              opacity={0.55}
              delay={1.6}
              duration={11}
            />
            <Blob
              hue="270 85% 65%"
              size={76}
              offsetX={-4}
              offsetY={12}
              blur={24}
              opacity={0.55}
              delay={3.3}
              duration={10}
            />
            <Blob
              hue="320 85% 62%"
              size={72}
              offsetX={14}
              offsetY={10}
              blur={22}
              opacity={0.5}
              delay={0.9}
              duration={12}
            />

            {/* Central mirror-highlight sheen */}
            <div
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 35% 30%, rgba(255,255,255,.45) 0%, rgba(255,255,255,0) 42%)",
                animation: "tsb-highlight 5.4s ease-in-out infinite"
              }}
            />

            {/* Glass edge — a very thin bright ring */}
            <div
              aria-hidden
              className="absolute inset-[6%] rounded-full ring-1 ring-white/10"
              style={{ boxShadow: "inset 0 0 40px rgba(255,255,255,.06)" }}
            />
            {/* Bottom-right specular highlight */}
            <div
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 72% 78%, rgba(255,255,255,.28) 0%, rgba(255,255,255,0) 22%)"
              }}
            />
          </div>
        </div>

        {/* Loading label */}
        <div className="mt-6 text-lg font-semibold tracking-wide text-white/85">
          Loading<DotDot />
        </div>

        {user?.name && (
          <div className="mt-2 text-xs text-white/50">
            Welcome back, <span className="font-semibold text-white/80">{user.name.split(" ")[0]}</span>
          </div>
        )}

        {/* Very subtle bottom progress hairline (matches the aesthetic — thin, low-opacity) */}
        <div className="mt-8 h-[2px] w-56 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${(progress * 100).toFixed(1)}%`,
              background:
                "linear-gradient(90deg, rgba(140,180,255,.85), rgba(220,170,255,.9), rgba(140,180,255,.85))",
              boxShadow: "0 0 12px rgba(160,180,255,.55)",
              transition: "width 60ms linear"
            }}
          />
        </div>
      </div>

      <style>{`
        @keyframes tsb-rays { to { transform: rotate(360deg); } }
        @keyframes tsb-bloom {
          0%,100% { transform: scale(1); opacity:.65; }
          50%    { transform: scale(1.08); opacity: 1; }
        }
        @keyframes tsb-highlight {
          0%,100% { transform: translate(0, 0) rotate(0deg); opacity: .95; }
          50%    { transform: translate(2%, -1%) rotate(6deg); opacity: 1; }
        }
        @keyframes tsb-blob-a {
          0%,100% { transform: translate(var(--x1), var(--y1)) scale(1); }
          33%     { transform: translate(calc(var(--x1) + 4%), calc(var(--y1) - 3%)) scale(1.06); }
          66%     { transform: translate(calc(var(--x1) - 3%), calc(var(--y1) + 5%)) scale(0.96); }
        }
        @keyframes tsb-dots {
          0%   { opacity: .2; }
          33%  { opacity: 1; }
          66%  { opacity: .5; }
          100% { opacity: .2; }
        }
      `}</style>
    </div>
  )
}

function Blob({
  hue, size, offsetX, offsetY, blur, opacity, delay, duration
}: {
  hue: string
  size: number
  offsetX: number
  offsetY: number
  blur: number
  opacity: number
  delay: number
  duration: number
}) {
  return (
    <div
      aria-hidden
      className="absolute left-1/2 top-1/2 rounded-full"
      style={{
        width: `${size}%`,
        height: `${size}%`,
        marginLeft: `-${size / 2}%`,
        marginTop: `-${size / 2}%`,
        background: `radial-gradient(circle at 40% 40%, hsl(${hue} / 0.95) 0%, hsl(${hue} / 0.55) 40%, hsl(${hue} / 0) 70%)`,
        filter: `blur(${blur}px)`,
        mixBlendMode: "screen",
        opacity,
        // CSS custom props consumed by the keyframes
        // @ts-expect-error - custom css vars
        ["--x1"]: `${offsetX}%`,
        ["--y1"]: `${offsetY}%`,
        animation: `tsb-blob-a ${duration}s ease-in-out ${delay}s infinite`
      }}
    />
  )
}

function DotDot() {
  return (
    <span aria-hidden>
      <span style={{ animation: "tsb-dots 1.4s infinite", animationDelay: "0s" }}>.</span>
      <span style={{ animation: "tsb-dots 1.4s infinite", animationDelay: ".2s" }}>.</span>
      <span style={{ animation: "tsb-dots 1.4s infinite", animationDelay: ".4s" }}>.</span>
    </span>
  )
}
