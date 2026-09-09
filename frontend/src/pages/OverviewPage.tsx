import { Link } from "react-router-dom"
import { AnalyticsPage } from "./AnalyticsPage"

/**
 * Overview = the analytics page (balance-over-time, in/out, status mix).
 * We keep Analytics as its own export so old links keep working.
 */
export function OverviewPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-brand-100 bg-brand-50/60 p-4 text-sm text-brand-800 dark:border-brand-500/20 dark:bg-brand-500/10 dark:text-brand-200">
        <strong>Overview</strong> — deeper charts of your money. Looking for the summary?
        Head back to <Link to="/app" className="underline">Dashboard</Link>.
      </div>
      <AnalyticsPage />
    </div>
  )
}
