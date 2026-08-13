import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { currentConnection, redactConnection } from '#/server/github-store'
import { currentHook, ensureRepoHook, HookError, HOOK_PATH } from '#/server/repo-hook'
import { repoRef } from '#/server/static-context'


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

      const hook = await currentHook(db)
      return Response.json({
        ...redactConnection(await currentConnection(db)),
        configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        templateRepo: env.GITHUB_TEMPLATE_REPO ?? null,
        // Reported rather than assumed: a connection made before this node
        // asked for hook access still works, it just cannot sync back.
        syncHook: hook ? { id: hook.hookId, url: hook.url } : null,
      })
    },

    /** Register the push webhook, or point an existing one back at this node. */
    POST: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      try {
        // The dispatcher address rather than the custom domain: GitHub stores
        // this URL, and the node's provisioned address is the one that cannot
        // change out from under it.
        const url = `${(env.PUBLIC_URL ?? '').replace(/\/+$/, '')}${HOOK_PATH}`
        const result = await ensureRepoHook(db, await repoRef(db), url)
        return Response.json({ ok: true, url, ...result })
      } catch (error) {
        if (error instanceof HookError) {
          return Response.json(
            { error: error.message, needsReconnect: error.needsReconnect },
            { status: error.status },
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        return Response.json({ error: message }, { status: 500 })
      }
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
