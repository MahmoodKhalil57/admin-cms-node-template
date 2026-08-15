import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Button } from '#/components/ui/button'

/**
 * What this node owes, and buying more.
 *
 * The operator's own bill, on the only console they have ever seen. Everything
 * behind it belongs to master — the customer, the card, the webhook and the
 * ledger — and this page cannot grant a single credit, which is what makes it
 * safe for the thing being billed to be the thing showing the bill.
 */

interface View {
  configured: boolean
  balance: { purchased: number; used: number; balance: number }
  packages: Array<{
    key: string
    name: string
    description: string | null
    credits: number
    price: number
    currency: string
    monthly: boolean
  }>
  subscription: {
    packageKey: string
    status: string
    currentPeriodEnd: string | null
  } | null
  error?: string
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      amount / 100,
    )
  } catch {
    return `${amount} ${currency}`
  }
}

export const BillingPage = () => {
  const notify = useNotify()
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/billing')
      .then((response) => response.json())
      .then(setView)
      .catch(() => setView(null))
  }, [])

  if (!view) {
    return <div className="text-muted-foreground p-6 text-sm">Reading the bill…</div>
  }

  if (view.error) {
    return (
      <div className="flex flex-col gap-2 p-6">
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{view.error}</p>
      </div>
    )
  }

  const buy = async (packageKey: string) => {
    setBusy(packageKey)
    const response = await fetch('/api/billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageKey }),
    })
    const body = await response.json().catch(() => ({}))
    setBusy(null)
    if (!response.ok || !body.url) {
      notify(body.error ?? 'Could not start the payment.', { type: 'error' })
      return
    }
    // Straight to Stripe. The card is typed on their domain, so no card number
    // is ever in a request this node serves.
    window.location.href = body.url
  }

  const { balance } = view
  const low = balance.balance < 0

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Credits pay for what this node does — a sign-up, an enquiry, an order,
          a file held. Running out never stops the node working; it just means
          you owe the difference.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border-border/70 bg-card flex flex-col gap-1 rounded-lg border p-4">
          <p className="text-muted-foreground text-xs">Credits bought</p>
          <p className="text-2xl font-semibold tabular-nums">{balance.purchased}</p>
        </div>
        <div className="border-border/70 bg-card flex flex-col gap-1 rounded-lg border p-4">
          <p className="text-muted-foreground text-xs">Used</p>
          <p className="text-2xl font-semibold tabular-nums">{balance.used}</p>
        </div>
        <div
          className={`flex flex-col gap-1 rounded-lg border p-4 ${
            low ? 'border-destructive/40 bg-destructive/5' : 'border-border/70 bg-card'
          }`}
        >
          <p className="text-muted-foreground text-xs">Balance</p>
          <p
            className={`text-2xl font-semibold tabular-nums ${
              low ? 'text-destructive' : ''
            }`}
          >
            {balance.balance}
          </p>
          {low ? (
            <p className="text-muted-foreground text-xs">
              Below zero. Nothing has stopped working.
            </p>
          ) : null}
        </div>
      </div>

      {view.subscription ? (
        <div className="border-border/70 bg-muted/30 rounded-lg border p-4 text-sm">
          On <strong>{view.subscription.packageKey}</strong> —{' '}
          {view.subscription.status}
          {view.subscription.currentPeriodEnd ? (
            <span className="text-muted-foreground">
              , renews{' '}
              {new Date(view.subscription.currentPeriodEnd).toLocaleDateString()}
            </span>
          ) : null}
        </div>
      ) : null}

      {!view.configured ? (
        <div className="border-border/70 bg-muted/30 rounded-lg border p-4 text-sm">
          The platform is not taking payments yet, so nothing can be bought here.
          Your usage is still being counted.
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {view.packages.map((option) => (
          <div
            key={option.key}
            className="border-border/70 bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-4"
          >
            <p className="font-medium">{option.name}</p>
            {option.description ? (
              <p className="text-muted-foreground flex-1 text-xs">
                {option.description}
              </p>
            ) : (
              <div className="flex-1" />
            )}
            <p className="text-lg font-semibold tabular-nums">
              {money(option.price, option.currency)}
              {option.monthly ? (
                <span className="text-muted-foreground text-xs font-normal">
                  {' '}
                  a month
                </span>
              ) : null}
            </p>
            <Button
              size="sm"
              disabled={!view.configured || busy !== null}
              onClick={() => buy(option.key)}
            >
              {busy === option.key
                ? 'Opening…'
                : option.monthly
                  ? 'Subscribe'
                  : 'Buy'}
            </Button>
          </div>
        ))}
      </div>

      <p className="text-muted-foreground max-w-prose text-xs">
        Payments are taken by the platform, not by this node — your card details
        never reach here. Credits arrive when the payment confirms, which is
        usually immediate but is decided by the payment provider rather than by
        this page.
      </p>
    </div>
  )
}
