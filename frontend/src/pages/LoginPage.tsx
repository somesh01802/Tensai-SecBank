import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Eye, EyeOff, Loader2, LogIn, ShieldCheck, User as UserIcon } from "lucide-react"
import toast from "react-hot-toast"

import { AuthShell } from "@/components/AuthShell"
import { authApi } from "@/api/auth"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"
import { cn } from "@/lib/utils"

type Mode = "mpin" | "password"
type Audience = "customer" | "admin"

export function LoginPage() {
  const [audience, setAudience] = useState<Audience>("customer")
  const [mode, setMode] = useState<Mode>("mpin")
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [mpin, setMpin] = useState("")
  const [showPass, setShowPass] = useState(false)
  const setAuth = useAuthStore((s) => s.setAuth)
  const startSession = useAuthStore((s) => s.startSession)
  const setLoginMeta = useAuthStore((s) => s.setLoginMeta)
  const navigate = useNavigate()
  const isAdmin = audience === "admin"
  const effectiveMode: Mode = isAdmin ? "password" : mode // admins sign in with email + password only

  const mutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data: any) => {
      setLoginMeta({ loginEventId: data.loginEventId, userRef: data.userRef })
      setAuth(data.user, data.token, Boolean(data.hasMpin))
      toast.success(`Welcome back, ${data.user.name.split(" ")[0]}`)
      if (data.user.role === "ADMIN") return navigate("/admin", { replace: true })
      // If MPIN is set → premium splash → dashboard.
      // If MPIN isn't set → go set it (mandatory gate).
      navigate(data.hasMpin ? "/splash" : "/mpin-setup", { replace: true })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Login failed"))
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startSession() // fresh X-Session-Id for this sign-in (correlates the whole session in Kibana)
    if (isAdmin) {
      if (!identifier.includes("@")) return toast.error("Admins sign in with their email address")
      mutation.mutate({ email: identifier, password, loginAs: "admin" })
    } else if (mode === "mpin") {
      if (!/^\d{10}$/.test(identifier)) return toast.error("Enter your 10-digit mobile number")
      if (!/^\d{6}$/.test(mpin)) return toast.error("Enter your 6-digit MPIN")
      mutation.mutate({ mobileNumber: identifier, mpin, loginAs: "customer" })
    } else {
      const isMobile = /^\d{10}$/.test(identifier)
      mutation.mutate(
        isMobile
          ? { mobileNumber: identifier, password, loginAs: "customer" }
          : { email: identifier, password, loginAs: "customer" }
      )
    }
  }

  return (
    <AuthShell
      title="Sign in to your account"
      subtitle="Enter your credentials to access your ledger."
      footer={
        <>
          Don't have an account?{" "}
          <Link to="/register" className="font-semibold text-brand-600 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Sign in as">
        {([["customer", "Customer", UserIcon], ["admin", "Admin", ShieldCheck]] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={audience === value}
            onClick={() => setAudience(value)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition",
              audience === value
                ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-600/10 dark:text-brand-300"
                : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {isAdmin && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Staff sign-in. Access is restricted and every action is audited.
        </p>
      )}

      <div className={cn("mb-4 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800", isAdmin && "hidden")}>
        <button
          type="button"
          onClick={() => setMode("mpin")}
          className={cn(
            "flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
            mode === "mpin" ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100" : "text-slate-500"
          )}
        >
          Mobile + MPIN
        </button>
        <button
          type="button"
          onClick={() => setMode("password")}
          className={cn(
            "flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
            mode === "password" ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100" : "text-slate-500"
          )}
        >
          Email/Mobile + Password
        </button>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">
            {effectiveMode === "mpin" ? "Mobile number" : isAdmin ? "Staff email" : "Email or Mobile"}
          </label>
          <input
            className="input font-mono"
            placeholder={effectiveMode === "mpin" ? "10-digit mobile" : isAdmin ? "you@yourbank.com" : "you@example.com or 10-digit mobile"}
            inputMode={effectiveMode === "mpin" ? "numeric" : undefined}
            maxLength={effectiveMode === "mpin" ? 10 : undefined}
            value={identifier}
            onChange={(e) => setIdentifier(effectiveMode === "mpin" ? e.target.value.replace(/\D/g, "").slice(0, 10) : e.target.value)}
            autoComplete={effectiveMode === "mpin" ? "tel" : "username"}
            required
          />
        </div>

        {effectiveMode === "mpin" ? (
          <div>
            <label className="label">MPIN</label>
            <input
              className="input text-center font-mono text-2xl tracking-[0.6em]"
              inputMode="numeric"
              maxLength={6}
              value={mpin}
              onChange={(e) => setMpin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••••"
              required
            />
          </div>
        ) : (
          <div>
            <label className="label">Password</label>
            <div className="relative">
              <input
                type={showPass ? "text" : "password"}
                className="input pr-11"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button type="button" onClick={() => setShowPass((v) => !v)} className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        <button type="submit" className="btn-primary w-full" disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {mutation.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  )
}
