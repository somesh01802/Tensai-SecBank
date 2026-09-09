import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Eye, EyeOff, Loader2, Save, ShieldCheck, UserCircle } from "lucide-react"
import toast from "react-hot-toast"

import { profileApi } from "@/api/profile"
import { apiErrorMessage } from "@/api/client"
import { useAuthStore } from "@/stores/authStore"

export function SettingsPage() {
  const queryClient = useQueryClient()
  const setUser = useAuthStore((s) => s.setUser)

  const profileQ = useQuery({ queryKey: ["profile"], queryFn: profileApi.get })

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  useEffect(() => {
    if (profileQ.data) {
      setName(profileQ.data.name)
      setEmail(profileQ.data.email)
    }
  }, [profileQ.data])

  const updateMutation = useMutation({
    mutationFn: profileApi.update,
    onSuccess: (p) => {
      toast.success("Profile saved")
      setUser(p)
      queryClient.invalidateQueries({ queryKey: ["profile"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Save failed"))
  })

  const [currentPass, setCurrentPass] = useState("")
  const [newPass, setNewPass] = useState("")
  const [showPass, setShowPass] = useState(false)

  const passMutation = useMutation({
    mutationFn: profileApi.changePassword,
    onSuccess: () => {
      toast.success("Password changed")
      setCurrentPass("")
      setNewPass("")
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Could not change password"))
  })

  const dirty =
    (profileQ.data && (profileQ.data.name !== name || profileQ.data.email !== email)) ??
    false

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
          Account
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Settings
        </h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const patch: { name?: string; email?: string } = {}
            if (name !== profileQ.data?.name) patch.name = name
            if (email !== profileQ.data?.email) patch.email = email
            if (Object.keys(patch).length === 0) return
            updateMutation.mutate(patch)
          }}
          className="card p-6"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <UserCircle className="h-4 w-4 text-brand-600" /> Profile
          </div>
          <div className="mt-4 space-y-4">
            <div>
              <label className="label">Full name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn-primary mt-6"
            disabled={!dirty || updateMutation.isPending}
          >
            {updateMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </button>
        </form>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!currentPass || !newPass) return
            if (newPass.length < 6) {
              toast.error("New password must be at least 6 characters")
              return
            }
            passMutation.mutate({ currentPassword: currentPass, newPassword: newPass })
          }}
          className="card p-6"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <ShieldCheck className="h-4 w-4 text-brand-600" /> Change password
          </div>
          <div className="mt-4 space-y-4">
            <div>
              <label className="label">Current password</label>
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  className="input pr-11"
                  value={currentPass}
                  onChange={(e) => setCurrentPass(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400"
                  aria-label="Toggle visibility"
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="label">New password</label>
              <input
                type={showPass ? "text" : "password"}
                className="input"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                required
                minLength={6}
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn-primary mt-6"
            disabled={passMutation.isPending}
          >
            {passMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Change password
          </button>
        </form>
      </div>
    </div>
  )
}
