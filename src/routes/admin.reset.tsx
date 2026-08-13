import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

/**
 * Where a reset link lands.
 *
 * Outside the admin app, like the join page: whoever follows this cannot sign
 * in, which is the whole reason they are here.
 */
function ResetPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const token =
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search).get('token') ?? '')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password, token }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setError(body.message ?? 'That link is no longer valid. Ask for another.')
        return
      }
      setDone(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-6">
      <div className="bg-card w-full max-w-sm rounded-xl border p-6 shadow-sm">
        <h1 className="font-display mb-1 text-xl font-semibold">
          Set a new password
        </h1>
        {done ? (
          <>
            <p className="text-muted-foreground mb-4 text-sm">
              Done. Sign in with your new password.
            </p>
            <a
              href="/admin"
              className="bg-primary text-primary-foreground inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
            >
              Go to sign in
            </a>
          </>
        ) : !token ? (
          <p className="text-muted-foreground text-sm">
            This link is missing its token. Ask for another reset.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              New password
              <input
                type="password"
                required
                minLength={8}
                className="border-input bg-background h-9 rounded-md border px-3"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <button
              type="submit"
              disabled={busy}
              className="bg-primary text-primary-foreground h-9 rounded-md text-sm font-medium disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save it'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/reset')({
  ssr: false,
  component: ResetPage,
})
