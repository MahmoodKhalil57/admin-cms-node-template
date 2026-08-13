import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { currentConnection } from '#/server/github-store'
import { errorResponse, repoRef } from '#/server/static-context'
import { getSettings } from '#/server/settings'
import { loadModel } from '#/server/static-store'

/** The content model, so the admin can build screens for it at runtime. */
export const Route = createFileRoute('/api/static/')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      // Editing the site's content only makes sense when the node publishes it.
      if (!(await getEnabledFeatures(db)).includes('github-pages')) {
        return Response.json({ collections: [], siteUrl: null })
      }

      try {
        const ref = await repoRef(db)
        const { collections } = await loadModel(ref)
        // Where the preview frame is served from — the operator's own site.
        const connection = await currentConnection(db)
        const settings = await getSettings(db)

        // Prefer the custom domain: GitHub redirects the github.io address to
        // it once set, and a redirecting iframe lands on a different origin
        // than the one the panel posts drafts to. On the custom domain the
        // panel and the preview share an origin, which is simpler and safer.
        const siteUrl =
          settings.customDomain && settings.frontendVerified
            ? `https://${settings.customDomain}`
            : (connection?.pagesUrl ?? null)

        return Response.json({ collections, siteUrl })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }),
)
