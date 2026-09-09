import { api } from "./client"
import type { Bill } from "@/types/api"

export const billsApi = {
  list: async () => {
    const { data } = await api.get<{ bills: Bill[] }>("/bills")
    return data.bills.map(cast)
  },
  create: async (payload: {
    billerName: string
    category: string
    amount: number
    dueDate?: string
    iconHint?: string
  }) => {
    const { data } = await api.post<{ bill: Bill }>("/bills", payload)
    return cast(data.bill)
  },
  pay: async (id: string, fromAccountId?: string) => {
    const { data } = await api.post<{ bill: Bill }>(`/bills/${id}/pay`, { fromAccountId })
    return cast(data.bill)
  },
  remove: async (id: string) => api.delete(`/bills/${id}`)
}

function cast(b: Bill): Bill {
  return { ...b, amount: Number(b.amount) }
}
