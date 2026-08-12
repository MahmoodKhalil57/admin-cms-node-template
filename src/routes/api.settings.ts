import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { apiRequirement, frontendRequirement } from '#/server/dns'
import { currentConnection } from '#/server/github-store'
import { cleanDomain, getSettings, publicApiBase, saveSettings } from '#/server/settings'

/**
 * Where the API domain must point.
 *
 * Everything reaches a node through the dispatch Worker, so a custom API domain
 * is a CNAME to it — never to the node's own script, which has no hostname of
 * its own.
 */
function dispatcherHost(publicUrl: string | undefined): string {
  try {
    return new URL(publicUrl ?? '').hostname
  } catch {
    return ''
  }
}

export const Route = createFileRoute('/api/settings')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      const current = await getSettings(db)
      const connection = await currentConnection(db)
      const host = dispatcherHost(env.PUBLIC_URL)

      return Response.json({
        apiDomain: current.apiDomain,
        apiVerified: current.apiVerified,
        frontendDomain: current.frontendDomain,
        frontendVerified: current.frontendVerified,
        /** the address in use right now, custom or not */
        apiBase: publicApiBase(env, current),
        githubOwner: connection?.login ?? null,
        pagesUrl: connection?.pagesUrl ?? null,
        /** what a record would have to say, so the UI can show it before saving */
        apiTarget: host,
        requirements: {
          api: current.apiDomain
            ? apiRequirement(current.apiDomain, host)
            : null,
          frontend:
            current.frontendDomain && connection?.login
              ? frontendRequirement(current.frontendDomain, connection.login)
              : null,
        },
      })
    },

    PUT: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        apiDomain?: string | null
        frontendDomain?: string | null
      }

      const patch: Record<string, string | null> = {}
      if ('apiDomain' in body) {
        const cleaned = cleanDomain(body.apiDomain)
        if (body.apiDomain && !cleaned) {
          return Response.json(
            { error: `"${body.apiDomain}" is not a valid domain name.` },
            { status: 400 },
          )
        }
        patch.apiDomain = cleaned
      }
      if ('frontendDomain' in body) {
        const cleaned = cleanDomain(body.frontendDomain)
        if (body.frontendDomain && !cleaned) {
          return Response.json(
            { error: `"${body.frontendDomain}" is not a valid domain name.` },
            { status: 400 },
          )
        }
        patch.frontendDomain = cleaned
      }

      const updated = await saveSettings(getDb(env), patch)
      return Response.json({ ok: true, settings: updated })
    },
  }),
)
