import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Trash2, UserPlus, Users } from "lucide-react"
import toast from "react-hot-toast"
import { Link } from "react-router-dom"

import { beneficiariesApi } from "@/api/beneficiaries"
import { apiErrorMessage } from "@/api/client"
import { EmptyState } from "@/components/EmptyState"
import { formatDate, shortId } from "@/lib/utils"

export function BeneficiariesPage() {
  const queryClient = useQueryClient()
  const listQ = useQuery({ queryKey: ["beneficiaries"], queryFn: beneficiariesApi.list })

  const [nickname, setNickname] = useState("")
  const [accountId, setAccountId] = useState("")

  const createMutation = useMutation({
    mutationFn: beneficiariesApi.create,
    onSuccess: () => {
      toast.success("Beneficiary added")
      setNickname("")
      setAccountId("")
      queryClient.invalidateQueries({ queryKey: ["beneficiaries"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Failed to add beneficiary"))
  })

  const removeMutation = useMutation({
    mutationFn: beneficiariesApi.remove,
    onSuccess: () => {
      toast.success("Beneficiary removed")
      queryClient.invalidateQueries({ queryKey: ["beneficiaries"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Failed to remove beneficiary"))
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!nickname.trim() || !accountId.trim()) return
    createMutation.mutate({ nickname: nickname.trim(), toAccountId: accountId.trim() })
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
          Payees
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Beneficiaries
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Save people you transfer to often. Nicknames stay private to your account.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {listQ.isLoading ? (
            <div className="card p-5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton mb-3 h-14" />
              ))}
            </div>
          ) : (listQ.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No beneficiaries yet"
              description="Add one on the right and it'll show up here — then you can pick it from the transfer screen."
            />
          ) : (
            <div className="card overflow-hidden">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {listQ.data!.map((b) => (
                  <li key={b.id} className="flex items-center gap-4 px-5 py-4">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white">
                      {initialsFor(b.nickname)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {b.nickname}
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          {b.beneficiaryAccountStatus}
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-slate-500">
                        {shortId(b.toAccountId, 10, 6)} · {b.beneficiaryOwnerName}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        Added {formatDate(b.createdAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => removeMutation.mutate(b.id)}
                      disabled={removeMutation.isPending}
                      className="btn-ghost !p-2 text-rose-500 hover:!text-rose-700"
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="lg:col-span-1">
          <form onSubmit={submit} className="card p-6">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Add a beneficiary
            </div>
            <div className="mt-4 space-y-4">
              <div>
                <label className="label">Nickname</label>
                <input
                  className="input"
                  placeholder="e.g. Mom, Landlord"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="label">Recipient account ID</label>
                <input
                  className="input font-mono text-xs"
                  placeholder="uuid…"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  required
                />
                <div className="mt-1.5 text-xs text-slate-500">
                  Ask the recipient for their account ID (visible on their{" "}
                  <Link to="/app/accounts" className="text-brand-600 hover:underline">
                    accounts page
                  </Link>
                  ).
                </div>
              </div>
              <button
                type="submit"
                className="btn-primary w-full"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                Add beneficiary
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}
