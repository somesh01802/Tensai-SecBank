import clsx, { type ClassValue } from "clsx"

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

export function formatCurrency(amount: number, _currency = "USD") {
  return currencyFormatter.format(amount)
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  })
}

export function shortId(id: string, head = 6, tail = 4) {
  if (!id) return ""
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

export function newIdempotencyKey() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}
