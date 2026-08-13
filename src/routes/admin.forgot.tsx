import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

/**
 * Asking for a reset link.
 *
 * Always answers the same way, whether or not the address has an account —
 * telling a stranger which addresses exist here is a favour to the wrong
 * person.
 */
function ForgotPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          redirectTo: `${window.location.origin}/admin/reset`,
        }),
      }).catch(() => undefined)
      setSent(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-6">
      <div className="bg-card w-full max-w-sm rounded-xl border p-6 shadow-sm">
        <h1 className="font-display mb-1 text-xl font-semibold">
          Forgotten password
        </h1>
        {sent ? (
          <p className="text-muted-foreground text-sm">
            If that address has an account here, a reset link is on its way. It
            expires in an hour.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              We will send a link to set a new one.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Email
              <input
                type="email"
                required
                className="border-input bg-background h-9 rounded-md border px-3"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="bg-primary text-primary-foreground h-9 rounded-md text-sm font-medium disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Send the link'}
            </button>
          </form>
        )}
        <a
          href="/admin"
          className="text-muted-foreground mt-4 inline-block text-sm underline"
        >
          Back to sign in
        </a>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/forgot')({
  ssr: false,
  component: ForgotPage,
})
