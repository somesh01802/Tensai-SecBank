import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, Wallet } from "lucide-react"
import toast from "react-hot-toast"

import { accountsApi } from "@/api/accounts"
import { apiErrorMessage } from "@/api/client"
import { AccountCard } from "@/components/AccountCard"
import { EmptyState } from "@/components/EmptyState"

export function AccountsPage() {
  const queryClient = useQueryClient()
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list })

  const createMutation = useMutation({
    mutationFn: accountsApi.create,
    onSuccess: () => {
      toast.success("Account created")
      queryClient.invalidateQueries({ queryKey: ["accounts"] })
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Failed to create account"))
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
            Manage
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Accounts
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Every account starts ACTIVE with 0 balance in INR.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Open new account
        </button>
      </div>

      {accountsQ.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-44" />
          ))}
        </div>
      ) : (accountsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Wallet className="h-6 w-6" />}
          title="No accounts yet"
          description="Open your first account and it's ready to receive funds."
          action={
            <button
              className="btn-primary"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              <Plus className="h-4 w-4" />
              Open account
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {accountsQ.data!.map((a, i) => (
            <AccountCard key={a.id} account={a} highlight={i === 0} />
          ))}
        </div>
      )}
    </div>
  )
}
