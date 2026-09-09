import { cn } from "@/lib/utils"

/**
 * Tensai SecBank — TSB brandmark.
 *
 * Design:
 *   - Rounded square tile in a deep-navy → brand-blue gradient (premium feel).
 *   - A tight, geometric "TSB" monogram in white with a warm gold accent bar
 *     underneath the S — a small dial of trust + luxury without being loud.
 *   - Optical adjustments so the mark stays legible at 20px and looks
 *     confident at 48px.
 */
export function LogoMark({
  className,
  size = 40,
  monochrome = false
}: {
  className?: string
  size?: number
  monochrome?: boolean
}) {
  const uid = "tsb-" + Math.random().toString(36).slice(2, 8)
  const bgFrom = monochrome ? "currentColor" : "#0e1a3c"
  const bgTo = monochrome ? "currentColor" : "#1a2fa0"
  const accent = monochrome ? "#ffffff" : "#f4c86a"

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      aria-label="Tensai SecBank"
      role="img"
    >
      <defs>
        <linearGradient id={`${uid}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={bgFrom} />
          <stop offset="100%" stopColor={bgTo} />
        </linearGradient>
        <linearGradient id={`${uid}-shine`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Tile */}
      <rect x="1" y="1" width="46" height="46" rx="12" fill={`url(#${uid}-tile)`} />
      <rect x="1" y="1" width="46" height="46" rx="12" fill={`url(#${uid}-shine)`} />

      {/* Subtle inner outline for premium detail */}
      <rect
        x="3"
        y="3"
        width="42"
        height="42"
        rx="10"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.08"
        strokeWidth="0.6"
      />

      {/*
        TSB monogram — geometric, tight kerning.
        Rendered as text for perfect kerning at any zoom;
        we lock the font stack to system UI + bold so it renders
        without loading fonts and stays crisp.
      */}
      <text
        x="24"
        y="30"
        fill="#ffffff"
        fontFamily="'Inter', 'SF Pro Display', system-ui, sans-serif"
        fontWeight="800"
        fontSize="16"
        letterSpacing="0.5"
        textAnchor="middle"
      >
        TSB
      </text>

      {/* Gold trust bar */}
      <rect x="16" y="35" width="16" height="1.5" rx="0.75" fill={accent} />
      {/* Tiny leading dot (used as a serif hint on the "T") */}
      <circle cx="12.5" cy="14" r="1.2" fill={accent} />
    </svg>
  )
}

/**
 * Full wordmark: mark + "TSB · Tensai SecBank" text.
 */
export function LogoWordmark({
  size = 36,
  compact = false,
  className
}: {
  size?: number
  compact?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark size={size} />
      <div className="leading-tight">
        <div className="flex items-baseline gap-1">
          <span className="text-[15px] font-extrabold tracking-tight text-slate-900 dark:text-white">
            Tensai
          </span>
          <span className="text-[15px] font-extrabold tracking-tight text-brand-600 dark:text-brand-400">
            SecBank
          </span>
        </div>
        {!compact && (
          <div className="text-[9px] font-semibold uppercase tracking-[0.22em] text-slate-400 dark:text-slate-500">
            TSB · Secure · Intelligent · Instant
          </div>
        )}
      </div>
    </div>
  )
}
