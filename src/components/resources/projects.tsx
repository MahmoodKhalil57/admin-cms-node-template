import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { holds, useMyPermissions } from '#/lib/my-permissions'

/**
 * Projects, built on the operator's own infrastructure.
 *
 * The screen makes one distinction visible because everything else depends on
 * it: **connecting an account and building on one are different jobs.** The
 * connect button is only offered to whoever holds `infra:connect`; a
 * collaborator sees whose account is connected, and builds on it.
 */

interface Project {
  id: number
  slug: string
  name: string
  status: string
  hostname: string | null
  imageVersion: string | null
  lastError: string | null
}

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
  imageUrl: string
}

const TONE: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  active: 'outline',
  provisioning: 'secondary',
  failed: 'destructive',
  suspended: 'destructive',
}

export const ProjectsPage = () => {
  const notify = useNotify()
  const mine = useMyPermissions()
  const [status, setStatus] = useState<Status | null>(null)
  const [rows, setRows] = useState<Array<Project>>([])
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  /** Cloudflare's own words, kept on screen rather than in a toast that goes */
  const [refusal, setRefusal] = useState<string | null>(null)

  const load = () => {
    void fetch('/api/infra/status')
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null))
    void fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((body) => setRows(Array.isArray(body) ? body : []))
      .catch(() => setRows([]))
  }

  useEffect(() => {
    load()
    // Cloudflare sends people back here with the outcome in the query, so it
    // is read once and then cleared — a reload should not re-announce it.
    const params = new URLSearchParams(window.location.search)
    const infra = params.get('infra')
    if (infra === 'connected') {
      notify('Cloudflare connected.', { type: 'info' })
    } else if (infra === 'declined') {
      notify('You declined the Cloudflare request.', { type: 'warning' })
    } else if (infra === 'error') {
      const detail = params.get('detail') ?? ''
      setRefusal(detail || 'Cloudflare refused the connection.')
      notify(detail || 'Cloudflare refused the connection.', { type: 'error' })
    }
    if (infra) {
      window.history.replaceState({}, '', window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) {
    return <div className="text-muted-foreground p-6 text-sm">Loading…</div>
  }

  const mayConnect = mine ? holds(mine, 'infra:connect') : false
  const mayCreate = mine ? holds(mine, 'projects:create') : false
  const connected = Boolean(status.cloudflare && !status.cloudflare.expired)

  const connect = async () => {
    const response = await fetch('/api/infra/authorize')
    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.url) {
      notify(body.error ?? 'Could not start the connection.', { type: 'error' })
      return
    }
    window.location.href = body.url
  }

  const create = async () => {
    setBusy(true)
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: slug.trim().toLowerCase() }),
    })
    const body = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) {
      notify(body.error ?? 'The project could not be built.', { type: 'error' })
      load()
      return
    }
    setSlug('')
    notify(`${body.slug} is up.`, { type: 'info' })
    load()
  }

  const destroy = async (project: Project) => {
    const response = await fetch(`/api/projects/${project.slug}`, {
      method: 'DELETE',
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      notify(body.error ?? 'Could not take it down.', { type: 'error' })
      return
    }
    notify('Taken down. Its database was kept.', { type: 'info' })
    load()
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Each one is a database, a session store and a Worker on{' '}
          <strong>your own Cloudflare account</strong> — billed to you, not to
          the platform, and built from a public release so none of the
          platform's keys are involved.
        </p>
      </div>

      <div className="border-border/70 bg-card flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {connected ? 'Cloudflare connected' : 'Cloudflare not connected'}
            </p>
            <p className="text-muted-foreground text-xs">
              {connected
                ? `Building on ${status.cloudflare?.accountName ?? status.cloudflare?.accountId ?? 'your account'}`
                : mayConnect
                  ? 'Projects need an account to be built on.'
                  : 'Somebody who can connect accounts needs to set this up.'}
            </p>
          </div>
          {mayConnect ? (
            <Button size="sm" variant={connected ? 'ghost' : 'default'} onClick={connect}>
              {connected ? 'Reconnect' : 'Connect Cloudflare'}
            </Button>
          ) : null}
        </div>

        {/*
          Cloudflare's verbatim refusal, and what to do about the one that
          actually happens. `invalid_scope` names a permission this OAuth
          application is not registered for — which is not something an
          operator can fix, and telling them to try again would waste their
          afternoon.
        */}
        {refusal ? (
          <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3">
            <p className="text-destructive text-xs">{refusal}</p>
            {refusal.includes('invalid_scope') ? (
              <p className="text-muted-foreground text-xs">
                That is a permission this platform's Cloudflare application is
                not registered to ask for. Nothing you can change on your
                account will help — whoever runs the platform has to add it to
                the application first.
              </p>
            ) : null}
          </div>
        ) : null}

        {status.cloudflare?.expired ? (
          <p className="text-destructive text-xs">
            The grant has run out. Cloudflare issues no refresh token, so
            reconnecting is the only way to renew it.
          </p>
        ) : null}

        {!status.configured ? (
          <p className="text-muted-foreground text-xs">
            This platform has no Cloudflare application configured, so it cannot
            ask for access at all.
          </p>
        ) : null}

        {/* What was asked for against what came back. The difference is the
            only way to explain a capability that turns out to be missing. */}
        {connected && status.cloudflare ? (
          <div className="text-muted-foreground flex flex-wrap gap-1 text-[11px]">
            {status.scopes.map((scope) => {
              const granted =
                status.cloudflare!.scopes.length === 0 ||
                status.cloudflare!.scopes.includes(scope)
              return (
                <span
                  key={scope}
                  className={`rounded border px-1.5 py-0.5 font-mono ${
                    granted ? 'border-border/70' : 'border-destructive/50 text-destructive'
                  }`}
                >
                  {scope}
                  {granted ? '' : ' — not granted'}
                </span>
              )
            })}
          </div>
        ) : null}

        <p className="text-muted-foreground text-[11px]">
          Cloudflare has no R2 scope, so projects built this way have no file
          storage of their own. Everything else works; selling a file to
          download does not.
        </p>
      </div>

      {mayCreate ? (
        <div className="border-border/70 bg-muted/30 flex flex-wrap items-center gap-2 rounded-lg border p-4">
          <Input
            className="h-8 max-w-xs"
            placeholder="my-project"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <Button size="sm" disabled={!connected || !slug.trim() || busy} onClick={create}>
            {busy ? 'Building…' : 'Build it'}
          </Button>
          <p className="text-muted-foreground w-full text-xs">
            Lowercase letters, numbers and hyphens. It takes a few seconds — a
            database, a session store and a Worker have to be made.
          </p>
        </div>
      ) : null}

      <div className="border-border/70 bg-card overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-border/70 border-b text-left text-xs">
            <tr>
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-4 py-2 font-medium">Where</th>
              <th className="px-4 py-2 font-medium">Build</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-border/40 border-b last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{row.slug}</td>
                <td className="px-4 py-2">
                  {row.hostname ? (
                    <a
                      className="underline"
                      href={`https://${row.hostname}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.hostname}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-[11px]">
                  {row.imageVersion?.slice(0, 12) ?? '—'}
                </td>
                <td className="px-4 py-2">
                  <Badge variant={TONE[row.status] ?? 'secondary'}>{row.status}</Badge>
                  {row.lastError ? (
                    <p className="text-destructive mt-1 max-w-md text-xs">
                      {row.lastError}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => destroy(row)}>
                    Take down
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-4" colSpan={5}>
                  Nothing built yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
