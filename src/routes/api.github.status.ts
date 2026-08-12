import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { currentConnection, redactConnection } from '#/server/github-store'

export const Route = createFileRoute('/api/github/status')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('github-pages')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      return Response.json({
        ...redactConnection(await currentConnection(db)),
        configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        templateRepo: env.GITHUB_TEMPLATE_REPO ?? null,
      })
    },

    DELETE: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      const { githubConnections } = await import('#/db/schema')
      await db.delete(githubConnections)
      return Response.json({ ok: true })
    },
  }),
)
