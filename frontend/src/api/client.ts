import axios, { AxiosError } from "axios"
import { useAuthStore } from "@/stores/authStore"

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
    if (error.response?.status === 401) {
      const path = window.location.pathname
      const isAuthPage = path === "/login" || path === "/register"
      if (!isAuthPage) {
        useAuthStore.getState().clear()
      }
    }
    return Promise.reject(error)
  }
)

export function apiErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  const axErr = err as AxiosError<{ message?: string }>
  return axErr?.response?.data?.message || axErr?.message || fallback
}
