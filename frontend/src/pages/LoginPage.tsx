import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react"
import toast from "react-hot-toast"

import { AuthShell } from "@/components/AuthShell"
import { authApi } from "@/api/auth"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"
import { cn } from "@/lib/utils"

type Mode = "mpin" | "password"

export function LoginPage() {
  const [mode, setMode] = useState<Mode>("mpin")
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [mpin, setMpin] = useState("")
  const [showPass, setShowPass] = useState(false)
  const setAuth = useAuthStore((s) => s.setAuth)
  const navigate = useNavigate()

  const mutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data: any) => {
      setAuth(data.user, data.token, Boolean(data.hasMpin))
      toast.success(`Welcome back, ${data.user.name.split(" ")[0]}`)
      navigate("/app", { replace: true })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Login failed"))
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (mode === "mpin") {
      if (!/^\d{10}$/.test(identifier)) return toast.error("Enter your 10-digit mobile number")
      if (!/^\d{6}$/.test(mpin)) return toast.error("Enter your 6-digit MPIN")
      mutation.mutate({ mobileNumber: identifier, mpin })
    } else {
      const isMobile = /^\d{10}$/.test(identifier)
      mutation.mutate(
        isMobile
          ? { mobileNumber: identifier, password }
          : { email: identifier, password }
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
      <div className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
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
            {mode === "mpin" ? "Mobile number" : "Email or Mobile"}
          </label>
          <input
            className="input font-mono"
            placeholder={mode === "mpin" ? "10-digit mobile" : "you@example.com or 10-digit mobile"}
            inputMode={mode === "mpin" ? "numeric" : undefined}
            maxLength={mode === "mpin" ? 10 : undefined}
            value={identifier}
            onChange={(e) => setIdentifier(mode === "mpin" ? e.target.value.replace(/\D/g, "").slice(0, 10) : e.target.value)}
            autoComplete={mode === "mpin" ? "tel" : "username"}
            required
          />
        </div>

        {mode === "mpin" ? (
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
