import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'

interface Status {
  connected: boolean
  login?: string
  repoOwner?: string | null
  repoName?: string | null
  pagesUrl?: string | null
  repoUrl?: string | null
  configured?: boolean
  templateRepo?: string | null
}

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: 'GitHub connected.',
  bad_state: 'That sign-in link had expired. Try connecting again.',
  missing_code: 'GitHub did not send a code back.',
  exchange_failed: 'GitHub refused the connection.',
  unconfigured: 'This node has no GitHub app configured.',
}

/**
 * Configuration for the `github-pages` feature.
 *
 * Lives on the feature's own page rather than in a separate collection: this is
 * one connection and two actions, which belongs with the switch that turns it
 * on, not in a table of its own.
 */
export const GithubPagesPanel = ({ featureId }: { featureId: number }) => {
  const notify = useNotify()
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [repoName, setRepoName] = useState('')
  const [existingRepo, setExistingRepo] = useState('')

  const refresh = () =>
    fetch('/api/github/status')
      .then((response) => (response.ok ? response.json() : { connected: false }))
      .then(setStatus)
      .catch(() => setStatus({ connected: false }))

  useEffect(() => {
    // The OAuth callback redirects back here with its outcome in the query.
    const outcome = new URLSearchParams(window.location.search).get('github')
    if (outcome) {
      notify(CALLBACK_MESSAGES[outcome] ?? outcome, {
        type: outcome === 'connected' ? 'success' : 'error',
      })
      window.history.replaceState({}, '', `/features/${featureId}`)
    }
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setUpSite = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const response = await fetch('/api/github/site', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = (await response.json()) as { ok?: boolean; error?: string }
      if (!response.ok || !result.ok) {
        notify(result.error ?? 'Could not set the site up.', { type: 'error' })
      } else {
        notify('Site published. GitHub Pages can take a minute to go live.', {
          type: 'success',
        })
        await refresh()
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), {
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!window.confirm('Disconnect GitHub? The repository itself is untouched.')) {
      return
    }
    await fetch('/api/github/status', { method: 'DELETE' })
    await refresh()
  }

  if (!status) return <p className="text-muted-foreground text-sm">Loading…</p>

  if (status.configured === false) {
    return (
      <div>
        <Card>
          <CardHeader>
            <CardTitle>Website</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            This node has no GitHub app configured, so it cannot connect to
            GitHub. The platform supplies those credentials when the node is
            provisioned.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {status.connected ? (
            <>
              <p>
                Connected as <strong>{status.login}</strong>.
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={disconnect}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                Connect GitHub so this node can create your website and publish
                it with GitHub Pages.
              </p>
              <Button
                type="button"
                className="w-fit"
                onClick={() => window.location.assign('/api/github/authorize')}
              >
                Connect GitHub
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {status.connected && (
        <Card>
          <CardHeader>
            <CardTitle>Your site</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm">
            {status.pagesUrl && (
              <div className="flex flex-col gap-1">
                <p>
                  Published at{' '}
                  <a
                    className="underline"
                    href={status.pagesUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {status.pagesUrl}
                  </a>
                </p>
                {status.repoUrl && (
                  <p className="text-muted-foreground">
                    Repository:{' '}
                    <a
                      className="underline"
                      href={status.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {status.repoOwner}/{status.repoName}
                    </a>
                  </p>
                )}
                <p className="text-muted-foreground">
                  A new Pages site can take a minute to answer for the first
                  time.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <p className="font-medium">Create a new site</p>
              <p className="text-muted-foreground">
                Generates a repository from{' '}
                <code>{status.templateRepo ?? 'the starter template'}</code>,
                points it at this node and turns Pages on.
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  placeholder="my-website"
                  value={repoName}
                  onChange={(event) => setRepoName(event.target.value)}
                  className="max-w-xs"
                />
                <Button
                  type="button"
                  disabled={busy || repoName.trim() === ''}
                  onClick={() => setUpSite({ mode: 'create', name: repoName.trim() })}
                >
                  {busy ? 'Working…' : 'Create site'}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <p className="font-medium">Or connect a repository you have</p>
              <p className="text-muted-foreground">
                Adds <code>config.js</code> if it is missing and enables Pages.
                You need admin rights on the repository.
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  placeholder="owner/repository"
                  value={existingRepo}
                  onChange={(event) => setExistingRepo(event.target.value)}
                  className="max-w-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || existingRepo.trim() === ''}
                  onClick={() =>
                    setUpSite({ mode: 'connect', repoFullName: existingRepo.trim() })
                  }
                >
                  {busy ? 'Working…' : 'Connect repository'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
