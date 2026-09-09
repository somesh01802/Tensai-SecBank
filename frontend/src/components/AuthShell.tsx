import { ShieldCheck, Layers, TrendingUp } from "lucide-react"
import { LogoMark } from "@/components/Logo"

export function AuthShell({
  title,
  subtitle,
  children,
  footer
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      {/* Left - branded panel */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-slate-950 p-12 text-white lg:flex lg:flex-col">
        <div className="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-400/20 blur-3xl" />
        <div className="absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <LogoMark size={44} />
          <div>
            <div className="flex items-baseline gap-1.5 text-lg font-extrabold tracking-tight">
              <span>Tensai</span>
              <span className="text-brand-200">SecBank</span>
            </div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-brand-200/80">
              Secure · Intelligent · Instant
            </div>
          </div>
        </div>

        <div className="relative mt-auto space-y-6">
          <h1 className="text-4xl font-bold leading-tight">
            Banking, done
            <br />
            <span className="bg-gradient-to-r from-white to-brand-200 bg-clip-text text-transparent">
              intelligently.
            </span>
          </h1>
          <p className="max-w-md text-brand-100">
            Tensai SecBank runs on an immutable double-entry ledger with
            idempotent transfers and a real-time balance you can trust.
          </p>

          <div className="grid gap-3 pt-4 sm:grid-cols-3">
            <Feature icon={<ShieldCheck className="h-4 w-4" />} label="Immutable" />
            <Feature icon={<Layers className="h-4 w-4" />} label="Double-entry" />
            <Feature icon={<TrendingUp className="h-4 w-4" />} label="Realtime" />
          </div>
        </div>
      </div>

      {/* Right - form */}
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <LogoMark size={36} />
            <div className="flex items-baseline gap-1 text-lg font-extrabold tracking-tight">
              <span>Tensai</span>
              <span className="text-brand-600 dark:text-brand-400">SecBank</span>
            </div>
          </div>

          <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {title}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>

          <div className="mt-8">{children}</div>

          {footer && (
            <div className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Feature({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 backdrop-blur">
      <span className="grid h-6 w-6 place-items-center rounded-md bg-white/10">
        {icon}
      </span>
      <span className="text-xs font-semibold">{label}</span>
    </div>
  )
}
