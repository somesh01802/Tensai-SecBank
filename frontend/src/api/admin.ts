import { api } from "./client"

/** Admin console API (/api/admin/*). Role is enforced by the server; every call is audited there. */

export interface Page<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

export interface AdminSummary {
  customers: { real: number; synthetic: number }
  accounts: { active: number; realBalance: number }
  attempts24h: { total: number; success: number; failure: number; avgDurationMs: number; failureCategories: { category: string; count: number }[] }
  feedback: { rating: string; count: number }[]
  logins24h: { success: number; failure: number }
}

export interface AdminCustomerRow {
  id: string
  name: string
  email: string
  mobile: string | null
  isSynthetic: boolean
  createdAt: string
  accountsCount: number
  totalBalance: number
  lastLoginAt: string | null
}

export interface AdminTxRow {
  refId: string
  refType: "TRANSACTION" | "ATTEMPT"
  createdAt: string
  amount: number | null
  status: string
  outcome: "SUCCESS" | "FAILURE" | "PENDING"
  kind: string | null
  category: string | null
  description: string | null
  errorCategory: string | null
  durationMs: number | null
  userId: string
  userName: string
  userEmail: string
  isSynthetic: boolean
  counterparty: string | null
  feedbackRating: string | null
  feedbackStatus: string | null
}

export interface AdminFeedbackRow {
  id: number
  status: string
  rating: string | null
  comment: string | null
  createdAt: string
  attemptId: string
  kind: string
  amount: number | null
  outcome: string
  errorCategory: string | null
  transactionId: string | null
  userId: string
  userName: string
  isSynthetic: boolean
}

export interface AdminAuditRow {
  id: string
  eventType: string
  entity: string | null
  entityId: string | null
  metadata: Record<string, unknown>
  ip: string | null
  createdAt: string
  actor: string | null
  actorEmail: string | null
}

type Params = Record<string, string | number | undefined>
const clean = (p: Params) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ""))

export const adminApi = {
  summary: async () => (await api.get<AdminSummary>("/admin/summary")).data,
  customers: async (p: Params) => (await api.get<Page<AdminCustomerRow>>("/admin/customers", { params: clean(p) })).data,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customer: async (id: string) => (await api.get<Record<string, any>>(`/admin/customers/${id}`)).data,
  transactions: async (p: Params) => (await api.get<Page<AdminTxRow>>("/admin/transactions", { params: clean(p) })).data,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: async (id: string) => (await api.get<Record<string, any>>(`/admin/transactions/${id}`)).data,
  feedback: async (p: Params) => (await api.get<Page<AdminFeedbackRow>>("/admin/feedback", { params: clean(p) })).data,
  audit: async (p: Params) => (await api.get<Page<AdminAuditRow>>("/admin/audit", { params: clean(p) })).data
}
