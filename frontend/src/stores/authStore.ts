import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { User } from "@/types/api"

interface AuthState {
  user: User | null
  token: string | null
  hasMpin: boolean
  justAuthed: boolean          // Ephemeral flag: triggers the splash screen once
  setAuth: (user: User, token: string, hasMpin?: boolean) => void
  setUser: (user: User | null) => void
  setHasMpin: (v: boolean) => void
  markJustAuthed: () => void
  clearJustAuthed: () => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      hasMpin: false,
      justAuthed: false,
      setAuth: (user, token, hasMpin) => set({ user, token, hasMpin: Boolean(hasMpin), justAuthed: true }),
      setUser: (user) => set({ user }),
      setHasMpin: (v) => set({ hasMpin: v }),
      markJustAuthed: () => set({ justAuthed: true }),
      clearJustAuthed: () => set({ justAuthed: false }),
      clear: () => set({ user: null, token: null, hasMpin: false, justAuthed: false })
    }),
    {
      name: "ledger-auth",
      // Don't persist the ephemeral flag; each new session decides fresh.
      partialize: (s) => ({ user: s.user, token: s.token, hasMpin: s.hasMpin })
    }
  )
)
