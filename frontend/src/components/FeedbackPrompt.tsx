import { useEffect, useState } from "react"
import { Frown, Loader2, Meh, Smile, X } from "lucide-react"
import toast from "react-hot-toast"
import type { AxiosError } from "axios"

import { experienceApi } from "@/api/v2"
import { useFeedbackStore } from "@/stores/feedbackStore"
import { useAuthStore } from "@/stores/authStore"
import type { FeedbackRating } from "@/types/api"
import { cn } from "@/lib/utils"

const OPTIONS: { rating: FeedbackRating; label: string; Icon: typeof Smile; tone: string }[] = [
  { rating: "HAPPY", label: "Happy", Icon: Smile, tone: "text-emerald-600" },
  { rating: "SATISFIED", label: "Satisfied", Icon: Meh, tone: "text-amber-500" },
  { rating: "NOT_SATISFIED", label: "Not satisfied", Icon: Frown, tone: "text-rose-600" }
]

/**
 * Shown after every completed transaction attempt — successful or not — that the
 * API answered with an attemptId. Submitting or dismissing is a separate request:
 * it can never change the transaction's outcome. The server accepts one response
 * per attempt, so a double-tap is harmless.
 */
export function FeedbackPrompt() {
  const offer = useFeedbackStore((s) => s.current)
  const close = useFeedbackStore((s) => s.close)
  const token = useAuthStore((s) => s.token)
  const locationPending = useAuthStore((s) => s.pendingLocationEventId !== null)
  const [rating, setRating] = useState<FeedbackRating | null>(null)
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => { setRating(null); setComment(""); setBusy(false) }, [offer?.attemptId])

  if (!offer || !token || locationPending) return null // waits for the location prompt (same corner)

  async function send(dismissed: boolean) {
    if (!offer) return
    setBusy(true)
    try {
      await experienceApi.feedback(dismissed
        ? { attemptId: offer.attemptId, dismissed: true }
        : { attemptId: offer.attemptId, rating: rating!, ...(comment.trim() ? { comment: comment.trim() } : {}) })
      if (!dismissed) toast.success("Thanks for your feedback")
    } catch (err) {
      const status = (err as AxiosError).response?.status
      if (!dismissed) toast(status === 409 ? "Feedback already recorded" : "Couldn't save feedback — your transaction is unaffected")
    } finally {
      close()
    }
  }

  return (
    <div role="dialog" aria-labelledby="fb-title"
      className="fixed bottom-6 left-4 z-50 w-[min(380px,calc(100vw-2rem))] sm:left-6 lg:left-72">
      <div className="card p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="fb-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">How was this transaction?</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {offer.ok ? "Completed" : "It didn't go through"}{offer.message ? ` · ${offer.message}` : ""}
            </p>
          </div>
          <button type="button" onClick={() => send(true)} disabled={busy} aria-label="Dismiss feedback"
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Rating">
          {OPTIONS.map(({ rating: r, label, Icon, tone }) => (
            <button key={r} type="button" role="radio" aria-checked={rating === r} onClick={() => setRating(r)} disabled={busy}
              className={cn("flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-xs font-medium transition",
                rating === r ? "border-brand-500 bg-brand-50 dark:bg-brand-600/10" : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")}>
              <Icon className={cn("h-6 w-6", tone)} aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {rating && (
          <>
            <label htmlFor="fb-comment" className="label mt-4">Comment (optional)</label>
            <textarea id="fb-comment" className="input min-h-[64px] resize-none" maxLength={500} value={comment}
              onChange={(e) => setComment(e.target.value)} placeholder="Tell us more…" disabled={busy} />
            <div className="mt-1 text-right text-[10px] text-slate-400">{comment.length}/500</div>
          </>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => send(true)} disabled={busy}>Dismiss</button>
          <button type="button" className="btn-primary px-3 py-2 text-xs" onClick={() => send(false)} disabled={busy || !rating}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Send feedback
          </button>
        </div>
      </div>
    </div>
  )
}
