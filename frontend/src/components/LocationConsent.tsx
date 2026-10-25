import { useState } from "react"
import { useLocation } from "react-router-dom"
import { Loader2, MapPin, X } from "lucide-react"

import { experienceApi } from "@/api/v2"
import { useAuthStore } from "@/stores/authStore"
import type { LocationStatus } from "@/types/api"

/**
 * Asks — explicitly, after sign-in — whether the customer will share their
 * sign-in location. The browser permission prompt only appears if they click
 * "Share location". Every outcome is recorded honestly (granted / denied /
 * dismissed / unavailable / timeout / error); coordinates are sent only when
 * permission is granted, and nothing is ever inferred from the IP address.
 */
export function LocationConsent() {
  const eventId = useAuthStore((s) => s.pendingLocationEventId)
  const token = useAuthStore((s) => s.token)
  const clearPending = useAuthStore((s) => s.clearPendingLocation)
  const { pathname } = useLocation()
  const [busy, setBusy] = useState(false)

  // Not over the splash animation / MPIN gate; the prompt waits until the app (or admin console) shows.
  if (!eventId || !token || pathname === "/splash" || pathname === "/mpin-setup") return null

  async function send(status: LocationStatus, coords?: GeolocationCoordinates) {
    try {
      await experienceApi.location({
        loginEventId: eventId!,
        status,
        ...(coords ? { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy } : {})
      })
    } catch {
      /* best-effort: never blocks the customer */
    } finally {
      setBusy(false)
      clearPending()
    }
  }

  function share() {
    if (!("geolocation" in navigator)) return send("unavailable")
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => send("granted", pos.coords),
      (err) => send(err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout"
        : err.code === err.POSITION_UNAVAILABLE ? "unavailable" : "error"),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 }
    )
  }

  return (
    <div role="dialog" aria-labelledby="loc-title" aria-describedby="loc-desc"
      className="fixed bottom-6 left-4 z-50 w-[min(360px,calc(100vw-2rem))] sm:left-6 lg:left-72">
      <div className="card p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-600/10 text-brand-600">
            <MapPin className="h-5 w-5" aria-hidden />
          </span>
          <div className="flex-1">
            <h2 id="loc-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">Share your sign-in location?</h2>
            <p id="loc-desc" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              It helps us spot sign-ins that don't look like you. Your browser will ask for permission, and you can say no.
            </p>
          </div>
          <button type="button" onClick={() => send("dismissed")} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label="Not now" disabled={busy}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => send("dismissed")} disabled={busy}>Not now</button>
          <button type="button" className="btn-primary px-3 py-2 text-xs" onClick={share} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            Share location
          </button>
        </div>
      </div>
    </div>
  )
}
