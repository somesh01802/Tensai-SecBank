import { useEffect } from "react"
import { Navigate, Route, Routes } from "react-router-dom"

import { useThemeStore } from "@/stores/themeStore"
import { useAuthStore } from "@/stores/authStore"
import { AppLayout } from "@/components/layout/AppLayout"
import { ProtectedRoute } from "@/components/ProtectedRoute"

import { LandingPage } from "@/pages/LandingPage"
import { LoginPage } from "@/pages/LoginPage"
import { RegisterPage } from "@/pages/RegisterPage"
import { MpinSetupPage } from "@/pages/MpinSetupPage"
import { SplashPage } from "@/pages/SplashPage"
import { ManageAccountPage } from "@/pages/ManageAccountPage"
import { RewardsPage } from "@/pages/RewardsPage"
import { NotificationsPage } from "@/pages/NotificationsPage"
import { DashboardPage } from "@/pages/DashboardPage"
import { OverviewPage } from "@/pages/OverviewPage"
import { LoansPage } from "@/pages/LoansPage"
import { InvestmentsPage } from "@/pages/InvestmentsPage"
import { CardsPage } from "@/pages/CardsPage"
import { BillsPage } from "@/pages/BillsPage"
import { TransferPage } from "@/pages/TransferPage"
import { TransactionsPage } from "@/pages/TransactionsPage"
import { AnalyticsPage } from "@/pages/AnalyticsPage"
import { SettingsPage } from "@/pages/SettingsPage"

export default function App() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.set)
  const isAuthed = useAuthStore((s) => Boolean(s.token))

  useEffect(() => {
    setTheme(theme)
  }, [theme, setTheme])

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />

      <Route
        path="/login"
        element={isAuthed ? <Navigate to="/app" replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={isAuthed ? <Navigate to="/app" replace /> : <RegisterPage />}
      />
      <Route
        path="/mpin-setup"
        element={
          <ProtectedRoute>
            <MpinSetupPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/splash"
        element={
          <ProtectedRoute requireMpin>
            <SplashPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/app"
        element={
          <ProtectedRoute requireMpin>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="accounts" element={<Navigate to="/app/manage-account" replace />} />
        <Route path="manage-account" element={<ManageAccountPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="rewards" element={<RewardsPage />} />
        <Route path="loans" element={<LoansPage />} />
        <Route path="investments" element={<InvestmentsPage />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="bills" element={<BillsPage />} />
        <Route path="transfer" element={<TransferPage />} />
        <Route path="beneficiaries" element={<Navigate to="/app/transfer" replace />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
