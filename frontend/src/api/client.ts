import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios"
import { useAuthStore } from "@/stores/authStore"
import { useFeedbackStore } from "@/stores/feedbackStore"
import { apm } from "@/apm"
import { useMpinPrompt, type PendingMpin } from "@/components/MpinPrompt"

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api"

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  timeout: 60_000
})

api.interceptors.request.use((config) => {
  // The session is the HttpOnly `token` cookie (withCredentials); this header is the CSRF check.
  config.headers["X-Tensai-Client"] = "web"
  const { sessionId } = useAuthStore.getState()
  // Correlates this request with the login session in APM traces and Kibana.
  if (sessionId) config.headers["X-Session-Id"] = sessionId
  return config
})

type ApiBody = { message?: string; attemptId?: string; code?: string }

const MAX_MPIN_TRIES = 3
let mpinQueue: Promise<unknown> = Promise.resolve() // one shared prompt: concurrent requests wait their turn

/**
 * Step-up MPIN: the API answered 428 MPIN_REQUIRED. Open the shared prompt and retry the
 * request with `mpin` in the JSON body. Wrong MPIN → the prompt shows the server message
 * (max 3 tries). Cancel → the original error, reading "MPIN entry cancelled".
 * The MPIN is never kept: it is scrubbed from the retried request's config afterwards.
 */
function retryWithMpin(error: AxiosError<ApiBody>): Promise<AxiosResponse> {
  const config = error.config as InternalAxiosRequestConfig & { _mpinRetry?: boolean }
  const body = typeof config.data === "string" ? (config.data ? JSON.parse(config.data) : {}) : (config.data ?? {})
  const run = () => new Promise<AxiosResponse>((resolve, reject) => {
    let tries = 0
    const set = (p: Partial<PendingMpin> | null) =>
      useMpinPrompt.setState((s) => ({ pending: p && s.pending ? { ...s.pending, ...p } : null }))
    useMpinPrompt.setState({ pending: {
      error: null,
      busy: false,
      cancel: () => {
        set(null)
        error.message = "MPIN entry cancelled"
        if (error.response) error.response.data = { ...error.response.data, message: "MPIN entry cancelled" }
        reject(error)
      },
      submit: async (mpin) => {
        tries++
        set({ busy: true, error: null })
        try {
          const r = await api.request({ ...config, data: { ...body, mpin }, _mpinRetry: true } as InternalAxiosRequestConfig)
          r.config.data = config.data
          set(null)
          resolve(r)
        } catch (e) {
          const err = e as AxiosError<ApiBody>
          if (err.config) err.config.data = config.data
          if (err.response?.data?.code === "MPIN_INVALID" && tries < MAX_MPIN_TRIES) {
            set({ busy: false, error: err.response.data.message || "Incorrect MPIN" })
            return
          }
          set(null)
          reject(err)
        }
      }
    } })
  })
  const p = mpinQueue.then(run, run)
  mpinQueue = p.catch(() => undefined)
  return p
}

api.interceptors.response.use(
  (r) => {
    // Every money movement returns attemptId → offer post-transaction feedback.
    const attemptId = (r.data as ApiBody | undefined)?.attemptId
    if (attemptId) useFeedbackStore.getState().offer({ attemptId, ok: true, message: (r.data as ApiBody).message })
    return r
  },
  (error: AxiosError<ApiBody>) => {
    const status = error.response?.status
    if (status === 428 && error.response?.data?.code === "MPIN_REQUIRED" && error.config
      && !(error.config as { _mpinRetry?: boolean })._mpinRetry) {
      return retryWithMpin(error)
    }
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
