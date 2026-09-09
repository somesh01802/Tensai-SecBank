import { api } from "./client"
import type { DashboardSummary } from "@/types/api"

export const dashboardApi = {
  summary: async () => {
    const { data } = await api.get<DashboardSummary>("/dashboard/summary")
    return data
  }
}
