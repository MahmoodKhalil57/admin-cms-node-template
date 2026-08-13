import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

/**
 * Where an invitation link lands.
 *
 * Outside the admin app on purpose: whoever follows this has no account yet, so
 * there is no session for the panel to read and nothing for it to render. It is
 * a single form that turns a token into a sign-in.
 */
function JoinPage() {
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
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
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, name }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'That did not work.')
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
          Join this workspace
        </h1>

        {done ? (
          <>
            <p className="text-muted-foreground mb-4 text-sm">
              Your account is ready. Sign in with the address you were invited
              at.
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
            This link is missing its invitation. Ask whoever invited you for a
            new one.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Choose a password and you are in.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Your name
              <input
                className="border-input bg-background h-9 rounded-md border px-3"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Password
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
              {busy ? 'Setting up…' : 'Create my account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/join')({
  ssr: false,
  component: JoinPage,
})
