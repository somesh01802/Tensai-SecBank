import { api } from "./client"
import type { Card } from "@/types/api"

export const cardsApi = {
  list: async () => {
    const { data } = await api.get<{ cards: Card[] }>("/cards")
    return data.cards
  },
  create: async (payload: {
    holderName?: string
    type?: "CREDIT" | "DEBIT"
    brand?: string
    colorHint?: string
    accountId?: string
  }) => {
    const { data } = await api.post<{ card: Card }>("/cards", payload)
    return data.card
  },
  freeze: async (id: string) => {
    const { data } = await api.post<{ card: Card }>(`/cards/${id}/freeze`)
    return data.card
  },
  remove: async (id: string) => api.delete(`/cards/${id}`)
}
