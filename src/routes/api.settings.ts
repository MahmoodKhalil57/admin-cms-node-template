import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { planDomain } from '#/server/domain-plan'
import { currentConnection } from '#/server/github-store'
import {
  cleanDomain,
  dispatcherHost,
  getSettings,
  publicApiBase,
  saveCustomDomain,
} from '#/server/settings'

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

      const purposes = current.customDomain
        ? planDomain({
            root: current.customDomain,
            dispatcherHost: dispatcherHost(env),
            githubOwner: connection?.login,
          })
        : []

      const verified: Record<string, boolean> = {
        frontend: current.frontendVerified,
        api: current.apiVerified,
      }

      return Response.json({
        customDomain: current.customDomain,
        apiBase: publicApiBase(env, current),
        defaultApiBase: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
        pagesUrl: connection?.pagesUrl ?? null,
        githubOwner: connection?.login ?? null,
        purposes: purposes.map((purpose) => ({
          ...purpose,
          verified: verified[purpose.key] ?? false,
        })),
      })
    },

    PUT: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        customDomain?: string | null
      }

      const cleaned = cleanDomain(body.customDomain)
      if (body.customDomain && !cleaned) {
        return Response.json(
          { error: `"${body.customDomain}" is not a valid domain name.` },
          { status: 400 },
        )
      }

      const updated = await saveCustomDomain(getDb(env), cleaned)
      return Response.json({ ok: true, customDomain: updated.customDomain })
    },
  }),
)
