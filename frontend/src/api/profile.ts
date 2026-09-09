import { api } from "./client"
import type { User } from "@/types/api"

export const profileApi = {
  get: async () => {
    const { data } = await api.get<{ profile: User }>("/profile")
    return data.profile
  },
  update: async (patch: { name?: string; email?: string }) => {
    const { data } = await api.patch<{ profile: User }>("/profile", patch)
    return data.profile
  },
  changePassword: async (payload: { currentPassword: string; newPassword: string }) => {
    await api.post("/profile/change-password", payload)
  }
}
