import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { User } from "@/types/api"

interface AuthState {
  user: User | null
  token: string | null
  hasMpin: boolean
  setAuth: (user: User, token: string, hasMpin?: boolean) => void
  setUser: (user: User | null) => void
  setHasMpin: (v: boolean) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      hasMpin: false,
      setAuth: (user, token, hasMpin) => set({ user, token, hasMpin: Boolean(hasMpin) }),
      setUser: (user) => set({ user }),
      setHasMpin: (v) => set({ hasMpin: v }),
      clear: () => set({ user: null, token: null, hasMpin: false })
    }),
    { name: "ledger-auth" }
  )
)
