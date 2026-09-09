import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import toast from "react-hot-toast"
import { Loader2, ShieldCheck, CheckCircle2 } from "lucide-react"

import { AuthShell } from "@/components/AuthShell"
import { authV2 } from "@/api/v2"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"

type Step = "CREATE" | "CONFIRM"

export function MpinSetupPage() {
  const navigate = useNavigate()
  const setHasMpin = useAuthStore((s) => s.setHasMpin)
  const [step, setStep] = useState<Step>("CREATE")
  const [pin1, setPin1] = useState("")
  const [pin2, setPin2] = useState("")

  const create1 = useRef<Array<HTMLInputElement | null>>([])
  const create2 = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (step === "CREATE") create1.current[0]?.focus()
    else create2.current[0]?.focus()
  }, [step])

  const mutation = useMutation({
    mutationFn: () => authV2.setMpin(pin1),
    onSuccess: () => {
      setHasMpin(true)
      toast.success("MPIN saved. You're all set!")
      navigate("/app", { replace: true })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not save MPIN"))
  })

  function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    if (pin1.length !== 6) return toast.error("Enter all 6 digits")
    setStep("CONFIRM")
  }
  function submitConfirm(e: React.FormEvent) {
    e.preventDefault()
    if (pin2.length !== 6) return toast.error("Enter all 6 digits")
    if (pin1 !== pin2) {
      toast.error("MPINs do not match")
      setPin2("")
      create2.current[0]?.focus()
      return
    }
    mutation.mutate()
  }

  return (
    <AuthShell
      title={step === "CREATE" ? "Create your 6-digit MPIN" : "Confirm your MPIN"}
      subtitle={
        step === "CREATE"
          ? "Your MPIN keeps future sign-ins fast and secure."
          : "Re-enter the same 6 digits."
      }
    >
      {step === "CREATE" ? (
        <form onSubmit={submitCreate} className="space-y-6">
          <PinGrid refs={create1} value={pin1} onChange={setPin1} />
          <button type="submit" className="btn-primary w-full">
            <ShieldCheck className="h-4 w-4" />
            Continue
          </button>
        </form>
      ) : (
        <form onSubmit={submitConfirm} className="space-y-6">
          <PinGrid refs={create2} value={pin2} onChange={setPin2} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setStep("CREATE"); setPin1(""); setPin2("") }}
              className="btn-secondary flex-1"
            >
              Back
            </button>
            <button type="submit" className="btn-primary flex-[2]" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save MPIN
            </button>
          </div>
        </form>
      )}
      <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:bg-slate-900/40">
        Your MPIN is stored securely as a bcrypt hash. Tensai SecBank will never ask you for it over
        email or phone.
      </div>
    </AuthShell>
  )
}

function PinGrid({
  value,
  onChange,
  refs
}: {
  value: string
  onChange: (v: string) => void
  refs: React.MutableRefObject<Array<HTMLInputElement | null>>
}) {
  const digits = value.padEnd(6).split("").slice(0, 6)
  return (
    <div className="flex justify-between gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          value={d.trim()}
          onChange={(e) => {
            const clean = e.target.value.replace(/\D/g, "").slice(-1)
            const next = value.split("")
            while (next.length < 6) next.push("")
            next[i] = clean
            onChange(next.join("").slice(0, 6))
            if (clean && i < 5) refs.current[i + 1]?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digits[i].trim() && i > 0) refs.current[i - 1]?.focus()
          }}
          inputMode="numeric"
          maxLength={1}
          className="h-14 w-12 rounded-xl border border-slate-200 bg-white text-center text-2xl font-bold text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          autoComplete="one-time-code"
        />
      ))}
    </div>
  )
}
