import "./apm" // Elastic RUM — must initialize before the app renders
import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "react-hot-toast"

import App from "./App"
import "./index.css"
import { useAuthStore, setApmUser } from "@/stores/authStore"

// Re-attach RUM user context after a page reload (store is rehydrated from
// localStorage, which doesn't re-run setAuth).
{
  const s = useAuthStore.getState()
  setApmUser(s.user, s.userRef, s.sessionId)
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000
    }
  }
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            className:
              "!bg-white dark:!bg-slate-900 !text-slate-900 dark:!text-slate-100 !border !border-slate-200 dark:!border-slate-800 !shadow-lg !rounded-xl"
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
