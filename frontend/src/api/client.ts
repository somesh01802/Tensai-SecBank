import axios, { AxiosError } from "axios"
import { useAuthStore } from "@/stores/authStore"
import { apm } from "@/apm"

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api"

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  timeout: 60_000
})

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (r) => r,
  (error: AxiosError<{ message?: string }>) => {
    const status = error.response?.status
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
