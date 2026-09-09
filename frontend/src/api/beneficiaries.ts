import { api } from "./client"
import type { Beneficiary } from "@/types/api"

export const beneficiariesApi = {
  list: async () => {
    const { data } = await api.get<{ beneficiaries: Beneficiary[] }>("/beneficiaries")
    return data.beneficiaries
  },
  create: async (payload: { nickname: string; toAccountId: string }) => {
    const { data } = await api.post<{ beneficiary: Beneficiary }>("/beneficiaries", payload)
    return data.beneficiary
  },
  remove: async (id: string) => {
    await api.delete(`/beneficiaries/${id}`)
  }
}
