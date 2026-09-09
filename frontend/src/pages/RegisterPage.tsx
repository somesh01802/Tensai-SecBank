import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Eye, EyeOff, Loader2, UserPlus } from "lucide-react"
import toast from "react-hot-toast"

import { AuthShell } from "@/components/AuthShell"
import { authApi } from "@/api/auth"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"

export function RegisterPage() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [mobileNumber, setMobileNumber] = useState("")
  const [password, setPassword] = useState("")
  const [showPass, setShowPass] = useState(false)
  const setAuth = useAuthStore((s) => s.setAuth)
  const navigate = useNavigate()

  const mutation = useMutation({
    mutationFn: authApi.register,
    onSuccess: (data: any) => {
      setAuth(data.user, data.token, Boolean(data.hasMpin))
      toast.success(`Welcome, ${data.user.name.split(" ")[0]}`)
      navigate("/mpin-setup", { replace: true })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Registration failed"))
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!/^\d{10}$/.test(mobileNumber)) {
      toast.error("Mobile number must be exactly 10 digits")
      return
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters")
      return
    }
    mutation.mutate({ name, email, password, mobileNumber } as any)
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Open a Tensai SecBank account in seconds."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-semibold text-brand-600 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="name">Full name</label>
          <input id="name" className="input" placeholder="Jane Doe" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" className="input" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>

        <div>
          <label className="label" htmlFor="mobile">Mobile number</label>
          <input
            id="mobile"
            className="input font-mono"
            placeholder="10-digit mobile"
            inputMode="numeric"
            maxLength={10}
            value={mobileNumber}
            onChange={(e) => setMobileNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="password">Password</label>
          <div className="relative">
            <input id="password" type={showPass ? "text" : "password"} className="input pr-11" placeholder="At least 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
            <button type="button" onClick={() => setShowPass((v) => !v)} className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
              {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <button type="submit" className="btn-primary w-full" disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {mutation.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  )
}
