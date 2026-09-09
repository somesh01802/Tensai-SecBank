import { api } from "./client"
import type { Investment, InvestmentType } from "@/types/api"

export const investmentsApi = {
  list: async () => {
    const { data } = await api.get<{ investments: Investment[] }>("/investments")
    return data.investments.map(cast)
  },
  create: async (payload: {
    type: InvestmentType
    name: string
    investedAmount: number
    currentValue?: number
    monthlyContribution?: number
    returnPct?: number
    frequencyLabel?: string
  }) => {
    const { data } = await api.post<{ investment: Investment }>("/investments", payload)
    return cast(data.investment)
  },
  remove: async (id: string) => api.delete(`/investments/${id}`)
}

function cast(i: Investment): Investment {
  return {
    ...i,
    investedAmount: Number(i.investedAmount),
    currentValue: Number(i.currentValue),
    monthlyContribution: i.monthlyContribution != null ? Number(i.monthlyContribution) : null,
    returnPct: i.returnPct != null ? Number(i.returnPct) : null
  }
}
