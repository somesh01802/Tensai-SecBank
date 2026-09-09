import { api } from "./client"
import type { AuthResponse, User } from "@/types/api"

export const authApi = {
  register: async (payload: { name: string; email: string; password: string; mobileNumber?: string }) => {
    const { data } = await api.post<AuthResponse & { needsMpin?: boolean }>("/auth/register", payload)
    return data
  },

  login: async (payload: { email?: string; mobileNumber?: string; password?: string; mpin?: string }) => {
    const { data } = await api.post<AuthResponse & { hasMpin?: boolean }>("/auth/login", payload)
    return data
  },

  logout: async () => {
    await api.post("/auth/logout")
  },

  me: async () => {
    const { data } = await api.get<{ user: User }>("/auth/me")
    return data.user
  }
}
