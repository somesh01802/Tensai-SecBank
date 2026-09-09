import { create } from "zustand"
import { persist } from "zustand/middleware"

type Theme = "light" | "dark"

interface ThemeState {
  theme: Theme
  toggle: () => void
  set: (theme: Theme) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "light",
      toggle: () => {
        const next = get().theme === "light" ? "dark" : "light"
        applyTheme(next)
        set({ theme: next })
      },
      set: (theme) => {
        applyTheme(theme)
        set({ theme })
      }
    }),
    {
      name: "ledger-theme",
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme)
      }
    }
  )
)

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === "dark") root.classList.add("dark")
  else root.classList.remove("dark")
}
