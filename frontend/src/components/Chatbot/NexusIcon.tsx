/**
 * Nexus — the Tensai SecBank AI assistant's brandmark.
 *
 * Design: a rounded hexagonal "coin" in a deep-navy → violet gradient with
 * a bold letter N inside and two orbiting nodes suggesting connectivity.
 * Simple, premium, legible at small sizes.
 */
export function NexusIcon({
  size = 28,
  className,
  animated = false
}: {
  size?: number
  className?: string
  animated?: boolean
}) {
  const uid = "nx-" + Math.random().toString(36).slice(2, 8)
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      aria-label="Nexus"
      role="img"
    >
      <defs>
        <linearGradient id={`${uid}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0e1a3c" />
          <stop offset="55%" stopColor="#2b3fc8" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <radialGradient id={`${uid}-glow`} cx="35%" cy="30%" r="60%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Rounded hex tile */}
      <path
        d="M12 6h24l6 6v24l-6 6H12l-6-6V12z"
        fill={`url(#${uid}-body)`}
      />
      <path
        d="M12 6h24l6 6v24l-6 6H12l-6-6V12z"
        fill={`url(#${uid}-glow)`}
      />

      {/* Bold "N" */}
      <text
        x="24"
        y="30"
        fill="#ffffff"
        fontFamily="'Inter', 'SF Pro Display', system-ui, sans-serif"
        fontWeight="900"
        fontSize="17"
        letterSpacing="-1"
        textAnchor="middle"
      >
        N
      </text>

      {/* Orbit nodes */}
      <circle cx="10" cy="34" r="1.4" fill="#f4c86a">
        {animated && (
          <animate attributeName="opacity" values="1;0.35;1" dur="2.8s" repeatCount="indefinite" />
        )}
      </circle>
      <circle cx="38" cy="14" r="1.4" fill="#8ac6ff">
        {animated && (
          <animate attributeName="opacity" values="0.35;1;0.35" dur="2.8s" repeatCount="indefinite" />
        )}
      </circle>

      {/* Subtle orbit hint */}
      <path
        d="M8 30c8 8 24 8 32 0"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.12"
        strokeWidth="0.6"
      />
    </svg>
  )
}
