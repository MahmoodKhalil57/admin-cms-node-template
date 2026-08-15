import { useEffect, useState } from 'react'

import { holds, useMyPermissions } from '#/lib/my-permissions'
import { useEnabledFeatures } from '#/lib/features'

/**
 * What has been happening here.
 *
 * Reads one endpoint and draws it. Everything about *whose* numbers these are
 * was decided on the server by the same grant that decides which rows a list
 * shows — so a vendor opening this page sees their own takings and their own
 * activity without a line of code here knowing what a vendor is.
 *
 * Deliberately plain. A dashboard's job is to be read at a glance on the way to
 * doing something else, and the fastest way to make one useless is to make it
 * something that has to be studied.
 */

interface Insights {
  from: string
  to: string
  totals: Array<{ name: string; label: string; area: string; count: number }>
  series: Array<{ date: string; count: number }>
  money: {
    currency: string
    gross: number
    vendorShare: number
    platformFee: number
    orders: number
  }
  recent: Array<{
    id: number
    name: string
    label: string
    at: string | null
    subjectType: string | null
    subjectId: string | null
  }>
}

const DAYS = [7, 30, 90]

function money(amount: number, currency: string): string {
  // Stored in the smallest unit, shown in the usual one. Two decimal places is
  // wrong for the handful of currencies that do not have them, which is worth
  // knowing about before this node sells in one.
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amount / 100)
  } catch {
    return `${amount} ${currency}`
  }
}

const Figure = ({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) => (
  <div className="border-border/70 bg-card flex min-w-0 flex-col gap-1 rounded-lg border p-4">
    <p className="text-muted-foreground text-xs">{label}</p>
    <p className="truncate text-2xl font-semibold tabular-nums">{value}</p>
    {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
  </div>
)

/**
 * A month of activity, as bars.
 *
 * Drawn with divs rather than a charting library. The whole shape of this is
 * "how tall is each day relative to the busiest one", and a dependency that
 * ships a rendering engine to answer that would be most of a megabyte in
 * everybody's panel for one picture.
 */
const Bars = ({ series }: { series: Insights['series'] }) => {
  const peak = Math.max(...series.map((day) => day.count), 1)
  return (
    <div className="border-border/70 bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <p className="text-muted-foreground text-xs">Activity by day</p>
      <div className="flex h-28 items-end gap-[2px]">
        {series.map((day) => (
          <div
            key={day.date}
            className="bg-primary/70 hover:bg-primary min-w-0 flex-1 rounded-t-[2px] transition-colors"
            style={{
              // A day with nothing on it still gets a sliver, so the axis reads
              // as a row of days rather than as a gap in the data.
              height: `${Math.max((day.count / peak) * 100, day.count > 0 ? 6 : 2)}%`,
            }}
            title={`${day.date}: ${day.count}`}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between text-[11px]">
        <span>{series[0]?.date}</span>
        <span>busiest day: {peak}</span>
        <span>{series.at(-1)?.date}</span>
      </div>
    </div>
  )
}

export function Dashboard() {
  const enabled = useEnabledFeatures()
  const mine = useMyPermissions()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Insights | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'off'>('loading')

  const on = enabled?.includes('instrumentation') ?? false
  const may = mine ? holds(mine, 'events:read') : false

  useEffect(() => {
    if (!on || !may) {
      if (enabled && mine) setState('off')
      return
    }
    setState('loading')
    void fetch(`/api/insights?days=${days}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        setData(body)
        setState(body ? 'ready' : 'off')
      })
      .catch(() => setState('off'))
  }, [days, on, may, enabled, mine])

  if (state === 'off') {
    return (
      <div className="flex flex-col gap-2 p-6">
        <h1 className="text-xl font-semibold">Nothing to show yet</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          {on
            ? 'Your account cannot read this node’s activity.'
            : 'Logs and analytics is switched off. The log is written either way — switching it on shows what has already happened, not a blank page.'}
        </p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-muted-foreground p-6 text-sm">Reading the log…</div>
    )
  }

  const busiest = data.totals[0]
  const total = data.totals.reduce((sum, row) => sum + row.count, 0)

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">What has been happening</h1>
        <div className="flex gap-1">
          {DAYS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                option === days
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/70 text-muted-foreground hover:bg-muted'
              }`}
            >
              {option} days
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Things that happened"
          value={String(total)}
          hint={busiest ? `most often: ${busiest.label}` : undefined}
        />
        <Figure
          label="Paid orders"
          value={String(data.money.orders)}
          hint={`in the last ${days} days`}
        />
        <Figure
          label="Taken"
          value={money(data.money.gross, data.money.currency)}
          hint="what buyers paid"
        />
        {/* Which of the two matters depends on who is reading, and both are
            true at once — so both are shown rather than one being guessed at. */}
        <Figure
          label="Owed to vendors"
          value={money(data.money.vendorShare, data.money.currency)}
          hint={`platform kept ${money(data.money.platformFee, data.money.currency)}`}
        />
      </div>

      <Bars series={data.series} />

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="border-border/70 bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4">
          <p className="text-muted-foreground text-xs">By kind</p>
          {data.totals.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing in this period.
            </p>
          ) : (
            data.totals.slice(0, 10).map((row) => (
              <div key={row.name} className="flex items-baseline gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="text-muted-foreground text-xs">{row.area}</span>
                <span className="tabular-nums">{row.count}</span>
              </div>
            ))
          )}
        </div>

        <div className="border-border/70 bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4">
          <p className="text-muted-foreground text-xs">Lately</p>
          {data.recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            data.recent.map((row) => (
              <div key={row.id} className="flex items-baseline gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {row.at
                    ? new Date(row.at).toLocaleString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : ''}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
