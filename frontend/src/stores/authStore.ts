import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { User } from "@/types/api"
import { apm } from "@/apm"
import { newIdempotencyKey } from "@/lib/utils"

/**
 * Tell Elastic RUM who the current user is and which login session this is.
 * Telemetry uses the privacy-safe userRef as user.id (not the database id) and
 * no email; the display name stays as user.name (existing dashboards use it).
 */
export function setApmUser(user: User | null, userRef?: string | null, sessionId?: string | null) {
  try {
    apm.setUserContext(user ? { id: userRef || undefined, username: user.name } : {})
    apm.addLabels({ session_id: sessionId || "", user_ref: userRef || "" })
  } catch {
    /* RUM disabled / not initialized — ignore */
  }
}

interface AuthState {
  user: User | null
  token: string | null
  hasMpin: boolean
  justAuthed: boolean          // Ephemeral flag: triggers the splash screen once
  sessionId: string | null     // per-login correlation id, sent as X-Session-Id
  userRef: string | null       // privacy-safe telemetry id from the API
  pendingLocationEventId: number | null // login awaiting the location-consent prompt
  setAuth: (user: User, token: string, hasMpin?: boolean) => void
  setUser: (user: User | null) => void
  setHasMpin: (v: boolean) => void
  markJustAuthed: () => void
  clearJustAuthed: () => void
  /** New session id for the login/register request that is about to be sent. */
  startSession: () => string
  setLoginMeta: (meta: { loginEventId?: number | null; userRef?: string | null }) => void
  clearPendingLocation: () => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      hasMpin: false,
      justAuthed: false,
      sessionId: null,
      userRef: null,
      pendingLocationEventId: null,
      setAuth: (user, token, hasMpin) => {
        setApmUser(user, get().userRef, get().sessionId)
        set({ user, token, hasMpin: Boolean(hasMpin), justAuthed: true })
      },
      setUser: (user) => {
        setApmUser(user, get().userRef, get().sessionId)
        set({ user })
      },
      setHasMpin: (v) => set({ hasMpin: v }),
      markJustAuthed: () => set({ justAuthed: true }),
      clearJustAuthed: () => set({ justAuthed: false }),
      startSession: () => {
        const sessionId = newIdempotencyKey()
        set({ sessionId })
        return sessionId
      },
      setLoginMeta: ({ loginEventId, userRef }) =>
        set({ pendingLocationEventId: loginEventId ?? null, userRef: userRef ?? null }),
      clearPendingLocation: () => set({ pendingLocationEventId: null }),
      clear: () => {
        setApmUser(null)
        set({ user: null, token: null, hasMpin: false, justAuthed: false, sessionId: null, userRef: null, pendingLocationEventId: null })
      }
    }),
    {
      name: "ledger-auth",
      // Don't persist the ephemeral flags; each new session decides fresh.
      partialize: (s) => ({ user: s.user, token: s.token, hasMpin: s.hasMpin, sessionId: s.sessionId, userRef: s.userRef })
    }
  )
)
