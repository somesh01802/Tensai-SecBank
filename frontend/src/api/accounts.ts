import { api } from "./client"
import type { Account, LedgerEntry } from "@/types/api"

export const accountsApi = {
  list: async () => {
    const { data } = await api.get<{ accounts: Account[] }>("/accounts")
    return data.accounts
  },

  create: async () => {
    const { data } = await api.post<{ account: Account }>("/accounts")
    return data.account
  },

  balance: async (accountId: string) => {
    const { data } = await api.get<{ accountId: string; balance: number }>(
      `/accounts/balance/${accountId}`
    )
    return data.balance
  },

  ledger: async (accountId: string) => {
    const { data } = await api.get<{ accountId: string; entries: LedgerEntry[] }>(
      `/accounts/${accountId}/ledger`
    )
    return data.entries
  }
}
