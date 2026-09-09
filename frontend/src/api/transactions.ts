import { api } from "./client"
import type { Transaction } from "@/types/api"

export interface TransactionListResponse {
  transactions: Transaction[]
  totals: { count: number; credit: number; debit: number }
  filter?: { from?: string; to?: string }
}

export const transactionsApi = {
  list: async (params?: { from?: string; to?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.from) qs.set("from", params.from)
    if (params?.to) qs.set("to", params.to)
    if (params?.limit) qs.set("limit", String(params.limit))
    const q = qs.toString()
    const { data } = await api.get<TransactionListResponse>(`/transactions${q ? "?" + q : ""}`)
    return data
  },

  create: async (payload: {
    fromAccount: string
    toAccount: string
    amount: number
    idempotencyKey: string
    description?: string
  }) => {
    const { data } = await api.post<{ message: string; transaction: Transaction }>(
      "/transactions",
      payload
    )
    return data.transaction
  },

  receive: async (payload: {
    amount: number
    remarks?: string
    sourceInfo?: string
    idempotencyKey: string
  }) => {
    const { data } = await api.post<{ message: string; transaction: Transaction }>(
      "/transactions/receive",
      payload
    )
    return data.transaction
  },

  statementUrl: (params?: { from?: string; to?: string }) => {
    const base = (import.meta.env.VITE_API_BASE_URL || "/api")
    const qs = new URLSearchParams()
    if (params?.from) qs.set("from", params.from)
    if (params?.to) qs.set("to", params.to)
    const q = qs.toString()
    return `${base}/transactions/statement.csv${q ? "?" + q : ""}`
  }
}
