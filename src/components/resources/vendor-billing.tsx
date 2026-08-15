import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

/**
 * What vendors owe the operator.
 *
 * One screen, two readers. A vendor arrives and sees their own balance and the
 * packages they can buy; the operator arrives and sees every vendor. Nothing
 * here decides which — the server narrows the list by what the asker acts for,
 * the same rule that scopes their listings and their sales.
 */

interface Balance {
  vendorId: number
  name: string
  purchased: number
  used: number
  balance: number
}

interface View {
  operator: boolean
  balances: Array<Balance>
  packages: Array<{
    key: string
    name: string
    description: string | null
    credits: number
    price: number
  }>
  periods: Array<{
    period: string
    credits: number
    lines: Array<{ item: string; name: string; quantity: number; credits: number }>
  }>
  error?: string
}

export const VendorBillingPage = () => {
  const notify = useNotify()
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [amounts, setAmounts] = useState<Record<number, string>>({})

  const load = () => {
    void fetch('/api/vendor-billing')
      .then((response) => response.json())
      .then(setView)
      .catch(() => setView(null))
  }

  useEffect(load, [])

  if (!view) {
    return <div className="text-muted-foreground p-6 text-sm">Reading…</div>
  }
  if (view.error) {
    return <div className="text-muted-foreground p-6 text-sm">{view.error}</div>
  }

  const buy = async (packageKey: string) => {
    setBusy(packageKey)
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ credits: packageKey }] }),
    })
    const body = await response.json().catch(() => ({}))
    setBusy(null)
    if (!response.ok || !body.url) {
      notify(body.error ?? 'Could not start the payment.', { type: 'error' })
      return
    }
    window.location.href = body.url
  }

  const grant = async (vendorId: number) => {
    const credits = Number(amounts[vendorId])
    if (!Number.isFinite(credits) || credits === 0) return
    const response = await fetch('/api/vendor-billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendorId, credits }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      notify(body.error ?? 'Could not add them.', { type: 'error' })
      return
    }
    setAmounts((current) => ({ ...current, [vendorId]: '' }))
    load()
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">
          {view.operator ? 'What vendors owe' : 'Your credits'}
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          {view.operator
            ? 'What each business here has used, and what they have paid for. Running out never stops a vendor selling.'
            : 'Credits pay for what you do here — a listing, an order, an appointment. Running out will not stop you selling.'}
        </p>
      </div>

      <div className="border-border/70 bg-card overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-border/70 border-b text-left text-xs">
            <tr>
              <th className="px-4 py-2 font-medium">Vendor</th>
              <th className="px-4 py-2 text-right font-medium">Bought</th>
              <th className="px-4 py-2 text-right font-medium">Used</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
              {view.operator ? <th className="px-4 py-2" /> : null}
            </tr>
          </thead>
          <tbody>
            {view.balances.map((row) => (
              <tr key={row.vendorId} className="border-border/40 border-b last:border-0">
                <td className="px-4 py-2">{row.name}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.purchased}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.used}</td>
                <td
                  className={`px-4 py-2 text-right tabular-nums ${
                    row.balance < 0 ? 'text-destructive font-medium' : ''
                  }`}
                >
                  {row.balance}
                </td>
                {view.operator ? (
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <Input
                        className="h-8 w-24"
                        placeholder="500"
                        value={amounts[row.vendorId] ?? ''}
                        onChange={(event) =>
                          setAmounts((current) => ({
                            ...current,
                            [row.vendorId]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => grant(row.vendorId)}
                      >
                        Add
                      </Button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
            {view.balances.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-4" colSpan={5}>
                  No vendors yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Only a vendor buys. The operator granting credits by hand is the row
          action above; they are not a customer of their own marketplace. */}
      {!view.operator && view.packages.length > 0 ? (
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
                {(option.price / 100).toFixed(2)}
              </p>
              <Button size="sm" disabled={busy !== null} onClick={() => buy(option.key)}>
                {busy === option.key ? 'Opening…' : `Buy ${option.credits}`}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {view.periods.length > 0 ? (
        <div className="flex flex-col gap-3">
          {view.periods.map((period) => (
            <div
              key={period.period}
              className="border-border/70 bg-card flex flex-col gap-2 rounded-lg border p-4"
            >
              <div className="flex items-baseline justify-between">
                <p className="font-medium">{period.period}</p>
                <p className="tabular-nums">{period.credits} credits</p>
              </div>
              {period.lines
                .filter((line) => line.credits > 0)
                .map((line) => (
                  <div
                    key={line.item}
                    className="text-muted-foreground flex items-baseline gap-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{line.name}</span>
                    <span className="tabular-nums">{line.quantity}</span>
                    <span className="text-foreground w-14 text-right tabular-nums">
                      {line.credits}
                    </span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
