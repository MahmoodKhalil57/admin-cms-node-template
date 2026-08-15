import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { holds, useMyPermissions } from '#/lib/my-permissions'

/**
 * Projects, built on the operator's own infrastructure.
 *
 * **Nothing here is about Cloudflare, and that is deliberate.** Connecting an
 * account is an operator's decision made once, on the feature's own page; this
 * is where somebody types a name and gets a site. A collaborator should never
 * have to know what the projects they build are standing on, let alone hold an
 * account of their own — putting a connect button here would have implied that
 * setting it up was their job, and blamed them for its absence.
 *
 * When it is not set up, the only honest thing to show is that it is not ready
 * and who can make it so.
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
    // Connecting an account happens on the feature's page and reports itself
    // there. Nothing about that flow lands here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) {
    return <div className="text-muted-foreground p-6 text-sm">Loading…</div>
  }

  const mayConnect = mine ? holds(mine, 'infra:connect') : false
  const mayCreate = mine ? holds(mine, 'projects:create') : false
  const connected = Boolean(status.cloudflare && !status.cloudflare.expired)

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

      {/*
        The only thing to say when it is not set up: that it is not, and who
        can fix it. A collaborator is not the person who connects an account,
        so this points at the operator rather than at a button they cannot use.
      */}
      {!connected ? (
        <div className="border-border/70 bg-muted/30 flex flex-col gap-1 rounded-lg border p-4">
          <p className="text-sm font-medium">Not ready yet</p>
          <p className="text-muted-foreground max-w-prose text-xs">
            {mayConnect ? (
              <>
                Projects need somewhere to be built. Set that up once under{' '}
                <a className="underline" href="/admin/features/7">
                  Features → Projects
                </a>
                , and after that anyone you make a collaborator can build one by
                typing a name.
              </>
            ) : (
              'Whoever runs this node needs to finish setting Projects up. Once they have, you can build one by typing a name — there is nothing for you to sign up to.'
            )}
          </p>
        </div>
      ) : null}

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
