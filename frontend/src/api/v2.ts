import { api } from "./client"
import type {
  Notification,
  Payee,
  LoanProduct,
  LoanApplication,
  CardProduct,
  RewardTask,
  RewardsSummary,
  AutoPay,
  RecurringBill,
  ScheduledTransfer,
  Frequency
} from "@/types/api"

/* ------------------------------- Auth v2 ------------------------------- */

export const authV2 = {
  setMpin: async (mpin: string) => api.post("/auth/mpin", { mpin }),
  hasMpin: async () => (await api.get<{ hasMpin: boolean }>("/auth/mpin")).data.hasMpin,
  loginWithMpin: async (mobileNumber: string, mpin: string) => {
    const { data } = await api.post("/auth/login", { mobileNumber, mpin })
    return data
  }
}

/* ------------------------------ Notifications ------------------------------ */

export const notificationsApi = {
  list: async () => (await api.get<{ notifications: Notification[]; unreadCount: number }>("/notifications")).data,
  markRead: async (id: string) => api.post(`/notifications/${id}/read`),
  markAllRead: async () => api.post(`/notifications/read-all`)
}

/* ------------------------------- Payees ---------------------------------- */

export const payeesApi = {
  banks: async () => (await api.get<{ banks: string[] }>("/payees/banks")).data.banks,
  list: async () => (await api.get<{ payees: Payee[] }>("/payees")).data.payees,
  create: async (payload: {
    bankName: string
    accountNumber: string
    confirmAccountNumber: string
    accountHolderName: string
    nickname: string
  }) => (await api.post<{ payee: Payee }>("/payees", payload)).data.payee,
  update: async (id: string, patch: Partial<Pick<Payee, "nickname" | "accountHolderName" | "active">>) =>
    (await api.patch<{ payee: Payee }>(`/payees/${id}`, patch)).data.payee,
  remove: async (id: string) => api.delete(`/payees/${id}`)
}

/* ------------------------------- Transfers ------------------------------- */

export const transferV2 = {
  quick: async (payload: {
    bankName: string
    accountNumber: string
    confirmAccountNumber: string
    accountHolderName: string
    amount: number
    remarks?: string
    sourceAccountId: string
    idempotencyKey: string
    savePayee?: boolean
  }) => (await api.post("/transfer/quick", payload)).data,
  listScheduled: async () =>
    (await api.get<{ scheduledTransfers: ScheduledTransfer[] }>("/transfer/scheduled")).data.scheduledTransfers,
  createScheduled: async (payload: {
    payeeId: string
    sourceAccountId: string
    amount: number
    remarks?: string
    frequency?: Frequency
    nextRunAt: string
  }) => (await api.post("/transfer/scheduled", payload)).data,
  toggleScheduled: async (id: string) => (await api.post(`/transfer/scheduled/${id}/toggle`)).data,
  cancelScheduled: async (id: string) => (await api.post(`/transfer/scheduled/${id}/cancel`)).data
}

/* --------------------------- Manage Account ---------------------------- */

export const accountAppApi = {
  apply: async (payload: {
    kind: "SAVINGS" | "SALARY" | "NRI" | "BUSINESS" | "INVESTMENT"
    applicantName: string
    pan: string
    pinCode: string
    occupation: string
    mobileNumber: string
    extra?: Record<string, unknown>
  }) => (await api.post("/account-applications", payload)).data,
  list: async () => (await api.get("/account-applications")).data
}

/* -------------------------------- Loans -------------------------------- */

export const loansApi = {
  products: async () => (await api.get<{ products: LoanProduct[] }>("/loans/products")).data.products,
  calculate: async (payload: { productCode: string; principal: number; tenureMonths: number }) =>
    (await api.post("/loans/calculate", payload)).data,
  apply: async (payload: { productCode: string; principal: number; tenureMonths: number }) =>
    (await api.post<{ application: LoanApplication }>("/loans/apply", payload)).data.application,
  applications: async () =>
    (await api.get<{ applications: LoanApplication[] }>("/loans/applications")).data.applications,
  detail: async (id: string) =>
    (await api.get<{
      application: LoanApplication
      product: LoanProduct
      schedule: Array<{ n: number; emi: number; interest: number; principal: number; outstanding: number }>
    }>(`/loans/applications/${id}`)).data,
  close: async (id: string, reason?: string) =>
    (await api.post<{ application: LoanApplication }>(`/loans/applications/${id}/close`, { reason })).data.application
}

/* ---------------------------- Card products ---------------------------- */

export const cardProductsApi = {
  list: async (params?: { category?: string; type?: "CREDIT" | "DEBIT" }) => {
    const qs = new URLSearchParams()
    if (params?.category) qs.set("category", params.category)
    if (params?.type) qs.set("type", params.type)
    const q = qs.toString()
    const { data } = await api.get<{ products: CardProduct[] }>(`/card-products${q ? "?" + q : ""}`)
    return data.products
  },
  apply: async (payload: { productCode: string; mobileNumber: string; pan: string; dob: string }) =>
    (await api.post("/card-applications", payload)).data,
  reveal: async (cardId: string) =>
    (await api.get<{ fullNumber: string; cvv: string; expiry: string }>(`/cards/${cardId}/reveal`)).data
}

/* --------------------------- Recurring Bills --------------------------- */

export const recurringBillsApi = {
  list: async () =>
    (await api.get<{ recurringBills: RecurringBill[] }>("/recurring-bills")).data.recurringBills,
  create: async (payload: {
    billerName: string
    category: string
    amount?: number
    autoDetectAmount?: boolean
    frequency?: Frequency
    sourceAccountId?: string
    autopayEnabled?: boolean
    nextRunAt: string
  }) => (await api.post("/recurring-bills", payload)).data.recurringBill,
  autoDetect: async (payload: { billerName: string; category: string }) =>
    (await api.post<{ source: string; amount: number; currency: string }>("/recurring-bills/auto-detect", payload)).data,
  toggle: async (id: string) => (await api.post(`/recurring-bills/${id}/toggle`)).data,
  remove: async (id: string) => api.delete(`/recurring-bills/${id}`)
}

/* --------------------------- Investment AutoPay ------------------------ */

export const autopayApi = {
  list: async () => (await api.get<{ autopays: AutoPay[] }>("/autopay")).data.autopays,
  create: async (payload: {
    investmentId: string
    sourceAccountId: string
    amount: number
    frequency?: Frequency
    nextRunAt: string
  }) => (await api.post<{ autopay: AutoPay }>("/autopay", payload)).data.autopay,
  toggle: async (id: string) => (await api.post(`/autopay/${id}/toggle`)).data,
  remove: async (id: string) => api.delete(`/autopay/${id}`),
  history: async () => (await api.get("/autopay/history")).data
}

/* ------------------------------ Statistics ------------------------------ */

export const statisticsApi = {
  get: async (range: "1D" | "1W" | "1M" | "1Y") =>
    (await api.get<{
      range: string
      bucket: string
      points: Array<{ ts: string; net: number; balance: number }>
    }>(`/statistics?range=${range}`)).data
}

/* ------------------------------- Rewards -------------------------------- */

export const rewardsApi = {
  list: async () =>
    (await api.get<{ summary: RewardsSummary; tasks: RewardTask[] }>("/rewards")).data,
  event: async (condition: string) =>
    (await api.post<{ awarded: boolean; task: { code: string; title: string; points: number } | null }>(
      "/rewards/event",
      { condition }
    )).data
}
