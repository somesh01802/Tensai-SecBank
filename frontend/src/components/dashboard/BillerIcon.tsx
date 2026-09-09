import {
  Percent,
  Phone,
  Tv,
  CreditCard,
  Zap,
  Wifi,
  Fuel,
  Receipt
} from "lucide-react"

/**
 * Small circular icon for a biller. We colorize by category and use a
 * lucide icon as a stand-in for the biller's real logo.
 */
export function BillerIcon({
  category,
  hint,
  size = 40
}: {
  category: string
  hint?: string | null
  size?: number
}) {
  const cfg = configFor(category, hint)
  const Icon = cfg.icon
  return (
    <div
      className="grid shrink-0 place-items-center rounded-xl text-white shadow-sm"
      style={{
        width: size,
        height: size,
        background: cfg.bg
      }}
      aria-label={cfg.label}
    >
      <Icon className="h-5 w-5" strokeWidth={2.25} />
    </div>
  )
}

function configFor(category: string, hint?: string | null) {
  const c = category.toUpperCase()
  const h = (hint || "").toLowerCase()
  if (c === "PHONE" || h.includes("airtel")) return { icon: Phone, bg: "linear-gradient(135deg,#ef4444,#b91c1c)", label: "Phone" }
  if (c === "CREDIT_CARD" || h.includes("cc")) return { icon: CreditCard, bg: "linear-gradient(135deg,#0ea5e9,#0369a1)", label: "Card" }
  if (c === "EMI" || h.includes("percent")) return { icon: Percent, bg: "linear-gradient(135deg,#10b981,#059669)", label: "EMI" }
  if (c === "STREAMING" || h.includes("netflix")) return { icon: Tv, bg: "linear-gradient(135deg,#dc2626,#7f1d1d)", label: "Streaming" }
  if (c === "ELECTRICITY") return { icon: Zap, bg: "linear-gradient(135deg,#f59e0b,#b45309)", label: "Utility" }
  if (c === "INTERNET") return { icon: Wifi, bg: "linear-gradient(135deg,#6366f1,#4338ca)", label: "Internet" }
  if (c === "FUEL") return { icon: Fuel, bg: "linear-gradient(135deg,#f97316,#c2410c)", label: "Fuel" }
  return { icon: Receipt, bg: "linear-gradient(135deg,#64748b,#334155)", label: "Bill" }
}
