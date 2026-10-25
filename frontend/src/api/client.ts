import axios, { AxiosError } from "axios"
import { useAuthStore } from "@/stores/authStore"
import { useFeedbackStore } from "@/stores/feedbackStore"
import { apm } from "@/apm"

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api"

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  timeout: 60_000
})

api.interceptors.request.use((config) => {
  const { token, sessionId } = useAuthStore.getState()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // Correlates this request with the login session in APM traces and Kibana.
  if (sessionId) config.headers["X-Session-Id"] = sessionId
  return config
})

type ApiBody = { message?: string; attemptId?: string }

api.interceptors.response.use(
  (r) => {
    // Every money movement returns attemptId → offer post-transaction feedback.
    const attemptId = (r.data as ApiBody | undefined)?.attemptId
    if (attemptId) useFeedbackStore.getState().offer({ attemptId, ok: true, message: (r.data as ApiBody).message })
    return r
  },
  (error: AxiosError<ApiBody>) => {
    const status = error.response?.status
    const attemptId = error.response?.data?.attemptId
    if (attemptId) useFeedbackStore.getState().offer({ attemptId, ok: false, message: error.response?.data?.message })
    if (status === 401) {
      const path = window.location.pathname
      const isAuthPage = path === "/login" || path === "/register"
      if (!isAuthPage) {
        useAuthStore.getState().clear()
      }
    } else if (!status || status >= 500) {
      // Network failure or server error — report to Elastic RUM (Kibana → Errors).
      try { apm.captureError(error as unknown as Error) } catch { /* ignore */ }
    }
    return Promise.reject(error)
  }
)

export function apiErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  const axErr = err as AxiosError<{ message?: string }>
  return axErr?.response?.data?.message || axErr?.message || fallback
}
