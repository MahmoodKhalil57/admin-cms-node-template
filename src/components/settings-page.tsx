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

interface Check extends Requirement {
  ok: boolean
  found: Array<string>
  message: string
  applied?: boolean
  note?: string
}

interface SettingsState {
  apiDomain: string | null
  apiVerified: boolean
  frontendDomain: string | null
  frontendVerified: boolean
  apiBase: string
  githubOwner: string | null
  pagesUrl: string | null
  apiTarget: string
  requirements: { api: Requirement | null; frontend: Requirement | null }
}

/** The record the user has to create, spelled out so it can be copied. */
const RecordHint = ({ requirement }: { requirement: Requirement | null }) => {
  if (!requirement) return null
  return (
    <div className="bg-muted rounded-md p-3 font-mono text-xs">
      <div>
        <span className="text-muted-foreground">Type&nbsp;&nbsp;</span>
        {requirement.type}
      </div>
      <div>
        <span className="text-muted-foreground">Name&nbsp;&nbsp;</span>
        {requirement.name}
      </div>
      <div>
        <span className="text-muted-foreground">Value&nbsp;</span>
        {requirement.expected.join(requirement.type === 'A' ? ' , ' : '')}
      </div>
    </div>
  )
}

const CheckResult = ({ check }: { check: Check | undefined }) => {
  if (!check) return null
  return (
    <p className={check.ok ? 'text-sm' : 'text-sm text-destructive'}>
      {check.ok ? '✓ ' : '✗ '}
      {check.message}
      {check.note ? ` ${check.note}` : ''}
    </p>
  )
}

/**
 * Node settings.
 *
 * Domains live here rather than on the features that use them: a node's
 * addresses belong to the node, and the API keeps its domain whether or not the
 * frontend feature is switched on.
 */
export const SettingsPage = () => {
  const notify = useNotify()
  const [state, setState] = useState<SettingsState | null>(null)
  const [apiDomain, setApiDomain] = useState('')
  const [frontendDomain, setFrontendDomain] = useState('')
  const [checks, setChecks] = useState<{ api?: Check; frontend?: Check }>({})
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const response = await fetch('/api/settings')
    if (!response.ok) return
    const body = (await response.json()) as SettingsState
    setState(body)
    setApiDomain(body.apiDomain ?? '')
    setFrontendDomain(body.frontendDomain ?? '')
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
        body: JSON.stringify({
          apiDomain: apiDomain.trim() || null,
          frontendDomain: frontendDomain.trim() || null,
        }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        notify(body.error ?? 'Could not save.', { type: 'error' })
      } else {
        notify('Saved. Add the records below, then check them.', {
          type: 'success',
        })
        setChecks({})
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
      const body = (await response.json()) as {
        checks?: { api?: Check; frontend?: Check }
      }
      setChecks(body.checks ?? {})
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
          <CardTitle>API domain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            The address your website posts form submissions to. Currently{' '}
            <code className="break-all">{state.apiBase}</code>.
          </p>
          <Input
            placeholder="api.example.com"
            value={apiDomain}
            onChange={(event) => setApiDomain(event.target.value)}
            className="max-w-sm"
          />
          {state.apiDomain && (
            <>
              <RecordHint requirement={state.requirements.api} />
              <p className="text-muted-foreground text-xs">
                A CNAME cannot sit on a bare domain, so use a subdomain such as
                <code> api.</code> unless your DNS provider flattens them.
              </p>
              <CheckResult check={checks.api} />
              {state.apiVerified && !checks.api && (
                <p className="text-sm">✓ Verified.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Website domain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {state.pagesUrl ? (
            <p className="text-muted-foreground">
              Your site is published at{' '}
              <a className="underline" href={state.pagesUrl} target="_blank" rel="noreferrer">
                {state.pagesUrl}
              </a>
              .
            </p>
          ) : (
            <p className="text-muted-foreground">
              Publish a site from the GitHub Pages feature first, then point a
              domain at it here.
            </p>
          )}
          <Input
            placeholder="www.example.com"
            value={frontendDomain}
            onChange={(event) => setFrontendDomain(event.target.value)}
            className="max-w-sm"
            disabled={!state.pagesUrl}
          />
          {state.frontendDomain && (
            <>
              <RecordHint requirement={state.requirements.frontend} />
              <CheckResult check={checks.frontend} />
              {state.frontendVerified && !checks.frontend && (
                <p className="text-sm">✓ Verified.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? 'Working…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={verify}
          disabled={busy || (!state.apiDomain && !state.frontendDomain)}
        >
          {busy ? 'Checking…' : 'Check DNS'}
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        DNS changes can take a few minutes to spread, so a check that fails
        straight after you add a record is normal — try again shortly.
      </p>
    </div>
  )
}
