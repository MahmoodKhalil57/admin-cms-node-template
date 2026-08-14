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
  onCloudflare: boolean
  cloudflareZone: string | null
  cloudflareConnected: boolean
  cloudflareConfigured: boolean
  purposes: Array<Purpose>
}

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: 'Cloudflare connected.',
  declined: 'You declined the Cloudflare request.',
  bad_state: 'That link had expired. Try connecting again.',
  missing_code: 'Cloudflare did not send a code back.',
  exchange_failed: 'Cloudflare refused the connection.',
  unconfigured: 'This node has no Cloudflare app configured.',
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
    // The Cloudflare callback redirects back here with its outcome in the query.
    const query = new URLSearchParams(window.location.search)
    const outcome = query.get('cloudflare')
    if (outcome) {
      // `detail` carries Cloudflare's own words for anything that is not one of
      // the outcomes worth phrasing ourselves. Saying "you declined" to
      // somebody who declined nothing sent everybody looking in the wrong
      // place, and the actual reason never reached anyone.
      const said =
        CALLBACK_MESSAGES[outcome] ?? query.get('detail') ?? outcome
      notify(said, {
        type: outcome === 'connected' ? 'success' : 'error',
        // Long enough to read a sentence from Cloudflare rather than glimpse it.
        autoHideDuration: outcome === 'connected' ? 4000 : 12000,
      })
      window.history.replaceState({}, '', '/admin/settings')
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyViaCloudflare = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/cloudflare/apply', { method: 'POST' })
      const body = (await response.json()) as {
        ok?: boolean
        error?: string
        written?: Array<{ name: string; type: string; action: string }>
      }
      if (!response.ok || !body.ok) {
        notify(body.error ?? 'Could not write the records.', { type: 'error' })
        return
      }
      const count = body.written?.length ?? 0
      notify(`${count} record${count === 1 ? '' : 's'} written. Checking them now…`, {
        type: 'success',
      })
      // Writing a record and it resolving are different claims, so fall through
      // to the same public DNS check the manual path uses.
      await verify()
    } finally {
      setBusy(false)
    }
  }

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

  /**
   * Asks the domain, from here.
   *
   * The browser is the only honest vantage point: Cloudflare bypasses a Worker
   * route for subrequests coming from its own Workers, so neither this node nor
   * the platform can see what the public sees. Your browser is the public.
   */
  const probeFromBrowser = async (
    domain: string,
  ): Promise<{ ok: boolean; node?: string }> => {
    try {
      const response = await fetch(`https://${domain}/api/health`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return { ok: false }
      const body = (await response.json()) as { node?: string }
      return { ok: true, node: body.node }
    } catch {
      return { ok: false }
    }
  }

  const verify = async () => {
    setBusy(true)
    try {
      // Probe first, then send the answer along — the server cannot obtain it.
      const apiProbe = state?.customDomain
        ? await probeFromBrowser(state.customDomain)
        : undefined

      const response = await fetch('/api/settings/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiProbe }),
      })
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

                  {purpose.requirement && state.onCloudflare && (
                    <p className="text-muted-foreground text-xs">
                      In Cloudflare, leave this record{' '}
                      <strong>proxied</strong> (orange cloud). The panel and the
                      API are handed to this node by Worker routes, and those
                      only fire on traffic that reaches Cloudflare — a DNS-only
                      record goes straight to your website host, and the panel
                      becomes unreachable.
                    </p>
                  )}

                  {result && (
                    <>
                      <p className={result.ok ? '' : 'text-destructive'}>
                        {result.ok ? '✓ ' : '✗ '}
                        {result.message}
                      </p>
                      {/* The DNS check and the set-up step succeed separately.
                          Reporting them on one line hid a failure behind a tick
                          the first time this ran. */}
                      {result.ok && result.note && (
                        <p
                          className={
                            result.applied ? '' : 'text-destructive'
                          }
                        >
                          {result.applied ? '✓ ' : '✗ '}
                          {result.note}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )
            })}

            {state.onCloudflare && (
              <div className="bg-muted flex flex-col gap-2 rounded-md p-3">
                <p className="font-medium">
                  {state.customDomain} is on Cloudflare
                  {state.cloudflareZone && state.cloudflareZone !== state.customDomain
                    ? ` (zone ${state.cloudflareZone})`
                    : ''}
                </p>
                {state.cloudflareZone && (
                  <a
                    className="text-xs underline"
                    href={`https://dash.cloudflare.com/?to=/:account/${state.cloudflareZone}/dns`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open this zone&rsquo;s DNS settings
                  </a>
                )}
                {!state.cloudflareConfigured ? (
                  <p className="text-muted-foreground">
                    Automatic setup is not available on this node — the platform
                    has no Cloudflare app configured. Add the records above by
                    hand.
                  </p>
                ) : state.cloudflareConnected ? (
                  <>
                    <p className="text-muted-foreground">
                      Cloudflare is connected, so the node can add these records
                      for you.
                    </p>
                    <Button
                      type="button"
                      className="w-fit"
                      onClick={applyViaCloudflare}
                      disabled={busy}
                    >
                      {busy ? 'Working…' : 'Add records automatically'}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      Connect it and the node will add these records for you,
                      instead of you copying them across. It asks only for
                      permission to read your zones and write DNS records.
                    </p>
                    <Button
                      type="button"
                      className="w-fit"
                      onClick={() =>
                        window.location.assign('/api/cloudflare/authorize')
                      }
                    >
                      Connect Cloudflare
                    </Button>
                  </>
                )}
              </div>
            )}

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
