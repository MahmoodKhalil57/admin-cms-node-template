import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'

/**
 * Configuration for the `projects` feature.
 *
 * **The setting-up happens here, once, and the using happens on the Projects
 * screen.** That split is the whole point of where this lives: connecting an
 * account is an operator's decision made a single time, and building on it is
 * something a collaborator does every week. Putting the connect button next to
 * the create form would have made every builder look at a piece of
 * infrastructure plumbing that is none of their business — and worse, would
 * have implied it was their job to fix when it was missing.
 *
 * So a collaborator opens Projects, types a name, and gets a site. Whether
 * Cloudflare is connected, whose account it is, and which permissions came back
 * are all questions answered on this page, by the person who can act on them.
 */

interface Status {
  configured: boolean
  cloudflare: {
    accountId: string | null
    accountName: string | null
    scopes: Array<string>
    expiresAt: string | null
    expired: boolean
  } | null
  scopes: Array<string>
  buildScopes: Array<string>
  missingForBuild: Array<string>
  imageUrl: string
}

export const ProjectsPanel = ({ featureId }: { featureId: number }) => {
  const notify = useNotify()
  const [status, setStatus] = useState<Status | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    fetch('/api/infra/status')
      .then((response) => (response.ok ? response.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null))

  useEffect(() => {
    void refresh()
    // Cloudflare sends the operator back to whichever screen they left from,
    // with the outcome in the query. Read once, then cleared — a reload should
    // not re-announce a connection made ten minutes ago.
    const params = new URLSearchParams(window.location.search)
    const infra = params.get('infra')
    if (infra === 'connected') {
      notify('Cloudflare connected. Projects can be built now.', { type: 'info' })
    } else if (infra === 'declined') {
      notify('You declined the Cloudflare request.', { type: 'warning' })
    } else if (infra === 'error') {
      const detail = params.get('detail') ?? ''
      setRefusal(detail || 'Cloudflare refused the connection.')
    }
    if (infra) window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) return null

  const connected = Boolean(status.cloudflare && !status.cloudflare.expired)

  const connect = async () => {
    setBusy(true)
    const response = await fetch(`/api/infra/authorize?from=${featureId}`)
    const body = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok || !body.url) {
      notify(body.error ?? 'Could not start the connection.', { type: 'error' })
      return
    }
    window.location.href = body.url
  }

  const disconnect = async () => {
    await fetch('/api/infra/status', { method: 'DELETE' })
    // The projects stay up. What goes is this node's ability to change them,
    // which is worth saying because "disconnect" reads like "delete".
    notify('Disconnected. Projects already built keep running.', { type: 'info' })
    void refresh()
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Where projects get built</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-muted-foreground max-w-prose text-sm">
          Connect your own Cloudflare account once, here. After that, anybody
          you have made a collaborator can create a project by typing a name —
          they never see Cloudflare, and never need an account of their own.
          Everything they build runs on your account and is billed to you, not
          to the platform.
        </p>

        <div className="border-border/70 bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {connected ? 'Connected' : 'Not connected'}
            </p>
            <p className="text-muted-foreground text-xs">
              {connected
                ? `Building on ${status.cloudflare?.accountName ?? status.cloudflare?.accountId ?? 'your account'}`
                : 'Until this is connected, nobody can create a project.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              <Button variant="ghost" size="sm" onClick={disconnect}>
                Disconnect
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={connected ? 'outline' : 'default'}
              disabled={busy || !status.configured}
              onClick={connect}
            >
              {busy
                ? 'Opening…'
                : connected
                  ? 'Reconnect'
                  : 'Connect Cloudflare'}
            </Button>
          </div>
        </div>

        {status.cloudflare?.expired ? (
          <p className="text-destructive text-xs">
            The grant has run out. Cloudflare issues no refresh token, so
            reconnecting is the only way to renew it — and until you do, nobody
            can create a project.
          </p>
        ) : null}

        {!status.configured ? (
          <p className="text-muted-foreground text-xs">
            This platform has no Cloudflare application configured, so it cannot
            ask for access at all.
          </p>
        ) : null}

        {/*
          Cloudflare's own words, kept on the page rather than in a toast that
          disappears. `invalid_scope` is the one that actually happens, and it
          is not something the operator can fix — telling them to try again
          would waste their afternoon.
        */}
        {refusal ? (
          <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3">
            <p className="text-destructive text-xs">{refusal}</p>
            {refusal.includes('invalid_scope') ? (
              <p className="text-muted-foreground text-xs">
                That is a permission this platform's Cloudflare application is
                not registered to request. Nothing on your account will change
                it — whoever runs the platform has to add it to the application
                first.
              </p>
            ) : null}
          </div>
        ) : null}

        {/*
          Connected is not the same as able to build.

          Cloudflare's OAuth application has to offer a permission before an
          operator can grant it, so a connection can be perfectly valid and
          still unable to create a database. Saying "connected" and then failing
          at the moment somebody clicks Build would leave them looking for the
          fault on their own account, which is the one place it is not.
        */}
        {connected && (status.missingForBuild ?? []).length > 0 ? (
          <div className="border-border/70 bg-muted/30 flex flex-col gap-1 rounded-md border p-3">
            <p className="text-sm font-medium">Connected, but not able to build yet</p>
            {/*
              Reconnecting is the fix in the ordinary case, and it is worth
              leading with: a grant carries whatever was asked for on the day it
              was made, so a connection older than a permission simply does not
              have it. Only if reconnecting changes nothing is it the
              application's registration, and that is somebody else's job.
            */}
            <p className="text-muted-foreground text-xs">
              This connection was made before these permissions were asked for.
              Reconnect to grant them — a grant only ever carries what was
              requested on the day it was made.
            </p>
            <p className="text-muted-foreground text-xs">
              If reconnecting changes nothing, they are missing from this
              platform's Cloudflare application and have to be added there
              first. Nothing on your account will change that.
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {status.missingForBuild.map((scope) => (
                <span
                  key={scope}
                  className="border-destructive/50 text-destructive rounded border px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {scope}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Asked for against granted. The difference is the only way to explain
            a capability that turns out to be missing later. */}
        {connected && status.cloudflare ? (
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs">What was granted</p>
            <div className="flex flex-wrap gap-1">
              {status.scopes.map((scope) => {
                const granted =
                  status.cloudflare!.scopes.length === 0 ||
                  status.cloudflare!.scopes.includes(scope)
                return (
                  <span
                    key={scope}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                      granted
                        ? 'border-border/70 text-muted-foreground'
                        : 'border-destructive/50 text-destructive'
                    }`}
                  >
                    {scope}
                    {granted ? '' : ' — refused'}
                  </span>
                )
              })}
            </div>
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs">
          Cloudflare offers no storage permission, so projects built this way
          have no file storage of their own. Everything else works; selling a
          file for download does not.
        </p>
      </CardContent>
    </Card>
  )
}
