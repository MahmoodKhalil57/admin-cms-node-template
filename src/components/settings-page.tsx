import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'

interface Requirement {
  type: 'A' | 'CNAME'
  name: string
  expected: Array<string>
}

interface Purpose {
  key: string
  label: string
  description: string
  hostname: string
  requirement: Requirement | null
  blocked?: string
  verified: boolean
}

interface Result {
  key: string
  ok: boolean
  found: Array<string>
  message: string
  applied: boolean
  note?: string
}

interface SettingsState {
  customDomain: string | null
  apiBase: string
  defaultApiBase: string
  pagesUrl: string | null
  githubOwner: string | null
  purposes: Array<Purpose>
}

/** The record to create, spelled out so it can be copied. */
const RecordRow = ({ requirement }: { requirement: Requirement }) => (
  <div className="bg-muted mt-2 rounded-md p-3 font-mono text-xs">
    <div>
      <span className="text-muted-foreground">Type&nbsp;&nbsp;</span>
      {requirement.type}
    </div>
    <div>
      <span className="text-muted-foreground">Name&nbsp;&nbsp;</span>
      {requirement.name}
    </div>
    {requirement.expected.map((value) => (
      <div key={value}>
        <span className="text-muted-foreground">Value&nbsp;</span>
        {value}
      </div>
    ))}
    {requirement.type === 'A' && requirement.expected.length > 1 && (
      <div className="text-muted-foreground mt-1">
        (all four, as separate records)
      </div>
    )}
  </div>
)

/**
 * Node settings.
 *
 * One domain for the whole node: the site, the API, and email when it lands.
 * Every hostname is derived from it, so there is one thing to type and one
 * place for it to be wrong.
 */
export const SettingsPage = () => {
  const notify = useNotify()
  const [state, setState] = useState<SettingsState | null>(null)
  const [domain, setDomain] = useState('')
  const [results, setResults] = useState<Record<string, Result>>({})
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const response = await fetch('/api/settings')
    if (!response.ok) return
    const body = (await response.json()) as SettingsState
    setState(body)
    setDomain(body.customDomain ?? '')
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customDomain: domain.trim() || null }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        notify(body.error ?? 'Could not save.', { type: 'error' })
      } else {
        notify(
          domain.trim()
            ? 'Saved. Add the records below, then check them.'
            : 'Custom domain removed.',
          { type: 'success' },
        )
        setResults({})
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/settings/verify', { method: 'POST' })
      const body = (await response.json()) as { results?: Array<Result> }
      const byKey: Record<string, Result> = {}
      for (const result of body.results ?? []) byKey[result.key] = result
      setResults(byKey)
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!state) return <p className="p-6 text-sm">Loading…</p>

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom domain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            One domain for the whole node. Your website goes on it, the API goes
            on a subdomain, and email will use it too.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="example.com"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="max-w-sm"
            />
            <Button type="button" onClick={save} disabled={busy}>
              {busy ? 'Working…' : 'Save'}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Currently serving the API at{' '}
            <code className="break-all">{state.apiBase}</code>
            {state.apiBase === state.defaultApiBase && ' (the default address)'}.
          </p>
        </CardContent>
      </Card>

      {state.customDomain && (
        <Card>
          <CardHeader>
            <CardTitle>DNS records</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm">
            {state.purposes.map((purpose) => {
              const result = results[purpose.key]
              return (
                <div key={purpose.key} className="flex flex-col gap-1">
                  <p className="font-medium">
                    {purpose.label}{' '}
                    {purpose.verified && !result && (
                      <span className="font-normal">— ✓ verified</span>
                    )}
                  </p>
                  <p className="text-muted-foreground">{purpose.description}</p>

                  {purpose.requirement ? (
                    <RecordRow requirement={purpose.requirement} />
                  ) : (
                    <p className="text-muted-foreground italic">
                      {purpose.blocked}
                    </p>
                  )}

                  {result && (
                    <p className={result.ok ? '' : 'text-destructive'}>
                      {result.ok ? '✓ ' : '✗ '}
                      {result.message}
                      {result.note ? ` ${result.note}` : ''}
                    </p>
                  )}
                </div>
              )
            })}

            <div>
              <Button
                type="button"
                variant="outline"
                onClick={verify}
                disabled={busy}
              >
                {busy ? 'Checking…' : 'Check DNS'}
              </Button>
              <p className="text-muted-foreground mt-2 text-xs">
                DNS changes take a few minutes to spread, so a check that fails
                right after you add a record is normal — try again shortly. Each
                record is checked on its own, so the website can go live while
                the API record is still propagating.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
