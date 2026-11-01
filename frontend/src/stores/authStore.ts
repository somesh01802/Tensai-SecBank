import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { User } from "@/types/api"
import { apm } from "@/apm"
import { newIdempotencyKey } from "@/lib/utils"

/** Nexus chat history (Chatbot.tsx); per user as `${CHAT_HISTORY_KEY}:${userRef}`, wiped on sign-out. */
export const CHAT_HISTORY_KEY = "tsb_nexus_history_v1"

/**
 * Tell Elastic RUM who the current user is and which login session this is.
 * Telemetry uses only the pseudonymous userRef as user.id (no database id, name or email).
 */
export function setApmUser(user: User | null, userRef?: string | null, sessionId?: string | null) {
  try {
    apm.setUserContext(user ? { id: userRef || undefined } : {})
    apm.addLabels({ session_id: sessionId || "", user_ref: userRef || "" })
  } catch {
    /* RUM disabled / not initialized — ignore */
  }
}

interface AuthState {
  user: User | null
  signedIn: boolean            // session lives in the HttpOnly cookie; this is only the UI flag
  hasMpin: boolean
  justAuthed: boolean          // Ephemeral flag: triggers the splash screen once
  sessionId: string | null     // per-login correlation id, sent as X-Session-Id
  userRef: string | null       // privacy-safe telemetry id from the API
  pendingLocationEventId: number | null // login awaiting the location-consent prompt
  setAuth: (user: User, token?: string | null, hasMpin?: boolean) => void
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
      signedIn: false,
      hasMpin: false,
      justAuthed: false,
      sessionId: null,
      userRef: null,
      pendingLocationEventId: null,
      setAuth: (user, _token, hasMpin) => {
        setApmUser(user, get().userRef, get().sessionId)
        set({ user, signedIn: true, hasMpin: Boolean(hasMpin), justAuthed: true })
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
        const ref = get().userRef
        try {
          localStorage.removeItem(CHAT_HISTORY_KEY)
          if (ref) localStorage.removeItem(`${CHAT_HISTORY_KEY}:${ref}`)
        } catch { /* ignore */ }
        set({ user: null, signedIn: false, hasMpin: false, justAuthed: false, sessionId: null, userRef: null, pendingLocationEventId: null })
      }
    }),
    {
      name: "ledger-auth",
      // v1: the bearer token is no longer kept; an old persisted token just means "signed in".
      version: 1,
      migrate: (persisted, version) => {
        const { token, ...rest } = (persisted ?? {}) as Record<string, unknown>
        return (version < 1 ? { ...rest, signedIn: Boolean(token) } : persisted) as AuthState
      },
      // Don't persist the ephemeral flags; each new session decides fresh.
      partialize: (s) => ({ user: s.user, signedIn: s.signedIn, hasMpin: s.hasMpin, sessionId: s.sessionId, userRef: s.userRef })
    }
  )
)
