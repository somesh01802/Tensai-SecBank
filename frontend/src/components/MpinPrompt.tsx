import { useEffect, useState } from "react"
import { Loader2, X } from "lucide-react"
import { create } from "zustand"

/** What the open prompt needs. Holds callbacks and the server message only — never the MPIN. */
export interface PendingMpin {
  error: string | null
  busy: boolean
  submit: (mpin: string) => void
  cancel: () => void
}

export const useMpinPrompt = create<{ pending: PendingMpin | null }>(() => ({ pending: null }))

/**
 * Step-up MPIN prompt, mounted once in App. The axios client opens it when the API
 * answers 428 MPIN_REQUIRED and retries the request with the MPIN; the digits live
 * only in this component's state and are wiped as soon as they are submitted.
 */
export function MpinPrompt() {
  const pending = useMpinPrompt((s) => s.pending)
  const [mpin, setMpin] = useState("")

  useEffect(() => { if (!pending) setMpin("") }, [pending]) // wipe on cancel / close

  if (!pending) return null

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!pending || pending.busy || !/^\d{6}$/.test(mpin)) return
    const value = mpin
    setMpin("")
    pending.submit(value)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div role="dialog" aria-labelledby="mpin-title"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <div>
            <div id="mpin-title" className="text-sm font-bold">Enter your MPIN</div>
            <div className="text-[11px] text-slate-500">
              Confirm this action with your 6-digit MPIN · Tensai SecBank
            </div>
          </div>
          <button type="button" onClick={pending.cancel} disabled={pending.busy} className="btn-ghost !p-2" aria-label="Cancel">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4 p-5">
          <div>
            <label className="label" htmlFor="mpin-step-up">MPIN</label>
            <input
              id="mpin-step-up"
              type="password"
              className="input text-center font-mono text-2xl tracking-[0.6em]"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={mpin}
              onChange={(e) => setMpin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••••"
              disabled={pending.busy}
              autoFocus
              required
            />
            {pending.error && <div className="mt-1.5 text-xs text-rose-600">{pending.error}</div>}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={pending.cancel} disabled={pending.busy}>Cancel</button>
            <button type="submit" className="btn-primary flex-[2]" disabled={pending.busy || mpin.length !== 6}>
              {pending.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
