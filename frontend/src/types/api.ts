export interface User {
  id: string
  _id?: string
  email: string
  name: string
  mobileNumber?: string | null
}

export interface AuthShape {
  user: User
  token: string
  hasMpin?: boolean
  needsMpin?: boolean
}

export type AccountStatus = "ACTIVE" | "FROZEN" | "CLOSED"

export interface Account {
  id: string
  _id?: string
  userId: string
  status: AccountStatus
  currency: string
  balance: number
  accountNumber?: string | null
  kind?: string
  displayName?: string | null
  isPrimary?: boolean
  closedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface Notification {
  id: string
  title: string
  body: string
  category: string
  severity: "INFO" | "SUCCESS" | "WARNING" | "ALERT"
  readAt: string | null
  actionUrl: string | null
  createdAt: string
}

export interface Payee {
  id: string
  bankName: string
  accountNumber: string
  accountHolderName: string
  nickname: string
  active: boolean
  createdAt: string
}

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" | "ONCE"

export interface LoanProduct {
  id: string
  code: string
  name: string
  description: string | null
  interestRate: number
  minAmount: number
  maxAmount: number
  minTenure: number
  maxTenure: number
}

export interface LoanApplication {
  id: string
  productId: string
  product?: { id: string; code: string; name: string } | null
  principal: number
  tenureMonths: number
  interestRate: number
  emi: number
  totalInterest: number
  totalRepayment: number
  status: string
  createdAt: string
}

export interface CardProduct {
  id: string
  code: string
  category: "EVERYDAY" | "LIFESTYLE" | "PREMIUM"
  cardType: "CREDIT" | "DEBIT"
  name: string
  tagline: string | null
  benefits: string[]
  annualFee: number
  colorHint: string
  network: string
}

export interface RewardTask {
  id: string
  code: string
  title: string
  description: string
  points: number
  completionCondition: string
  category: string
  completed: boolean
  completedAt: string | null
  pointsAwarded: number | null
}

export interface RewardsSummary {
  totalPoints: number
  completedCount: number
}

export interface AutoPay {
  id: string
  investmentId: string
  sourceAccountId: string
  amount: number
  frequency: Frequency
  nextRunAt: string
  enabled: boolean
  createdAt: string
}

export interface RecurringBill {
  id: string
  billerName: string
  category: string
  amount: number
  autoDetectAmount: boolean
  frequency: Frequency
  sourceAccountId: string | null
  autopayEnabled: boolean
  nextRunAt: string
  enabled: boolean
  createdAt: string
}

export interface ScheduledTransfer {
  id: string
  payeeId: string
  payeeName?: string
  bankName?: string
  sourceAccountId: string
  amount: number
  remarks: string | null
  frequency: Frequency
  nextRunAt: string
  enabled: boolean
  status: string
  createdAt: string
}

export type TransactionStatus = "PENDING" | "COMPLETED" | "FAILED" | "REVERSED"
export type TransactionDirection = "IN" | "OUT"

export interface Transaction {
  id: string
  _id: string
  fromAccount: string
  toAccount: string
  amount: number
  status: TransactionStatus
  idempotencyKey: string
  description: string | null
  category?: string | null
  createdAt: string
  updatedAt: string
  direction?: TransactionDirection
}

export type LedgerType = "CREDIT" | "DEBIT"

export interface LedgerEntry {
  _id: string
  account: string
  amount: number
  type: LedgerType
  transaction: {
    _id: string
    status: TransactionStatus
    createdAt: string
    fromAccount: string
    toAccount: string
  } | string
}

export interface Beneficiary {
  id: string
  nickname: string
  toAccountId: string
  createdAt: string
  beneficiaryAccountStatus: AccountStatus
  beneficiaryOwnerName: string
}

export interface AuthResponse {
  user: User
  token: string
}

export type InvestmentType =
  | "MUTUAL_FUND"
  | "LIFE_INSURANCE"
  | "FIXED_DEPOSIT"
  | "STOCKS"
  | "RECURRING_DEPOSIT"

export interface Investment {
  id: string
  type: InvestmentType
  name: string
  investedAmount: number
  currentValue: number
  monthlyContribution: number | null
  returnPct: number | null
  frequencyLabel: string | null
  createdAt: string
}

export type CardType = "CREDIT" | "DEBIT"

export interface Card {
  id: string
  userId: string
  accountId: string | null
  holderName: string
  lastFour: string
  expiryMonth: number
  expiryYear: number
  type: CardType
  brand: string
  colorHint: string
  isFrozen: boolean
  createdAt: string
}

export type BillStatus = "DUE" | "PAID" | "OVERDUE"

export interface Bill {
  id: string
  billerName: string
  category: string
  iconHint: string | null
  amount: number
  dueDate: string | null
  status: BillStatus
  paidAt: string | null
  paidTxId: string | null
  createdAt: string
}

export interface DashboardSummary {
  totalBalance: number
  accounts: Account[]
  primaryAccount: Account | null
  investments: Investment[]
  cards: Card[]
  bills: Bill[]
  recentTransactions: Array<{
    id: string
    fromAccount: string
    toAccount: string
    amount: number
    status: TransactionStatus
    description: string | null
    category: string | null
    createdAt: string
    direction: TransactionDirection
  }>
  expenditureByCategory: Array<{ category: string; total: number }>
  statistics: Array<{ day: string; net: number }>
  quickTransfer: Array<{
    id: string
    nickname: string
    toAccountId: string
    beneficiaryOwnerName: string
  }>
}
