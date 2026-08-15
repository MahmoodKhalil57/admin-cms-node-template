import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import {
  BUILD_SCOPES,
  currentInfra,
  forgetInfra,
  infraScopes,
  missingForBuild,
} from '#/server/infra'
import { imageUrl } from '#/server/projects/image'

/**
 * Whether this node can build projects, and on whose account.
 *
 * Readable by anyone who may see projects — a collaborator needs to know
 * whether there is a connection before they try to use it, and being told
 * "Cloudflare is not connected" by a failed provision is a worse way to find
 * out. What they cannot do is change it.
 */
export const Route = createFileRoute('/api/infra/status')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      const denied = await requirePermission(env, db, request, 'projects:read')
      if (denied) return denied

      const cloudflare = await currentInfra(db, 'cloudflare')
      return Response.json({
        configured: Boolean(env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET),
        cloudflare,
        /** what would be asked for, so a refusal can be matched against it */
        scopes: infraScopes(env),
        /** what building additionally needs, and what of it is absent */
        buildScopes: BUILD_SCOPES,
        missingForBuild: cloudflare ? missingForBuild(cloudflare.scopes) : BUILD_SCOPES,
        /** where the build comes from — public, and no key of ours involved */
        imageUrl: imageUrl(env),
      })
    },

    DELETE: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const denied = await requirePermission(env, db, request, 'infra:connect')
      if (denied) return denied

      // The projects stay. Their infrastructure is on the operator's account
      // and keeps running; what goes is this node's ability to change it.
      await forgetInfra(db, 'cloudflare')
      return Response.json({ ok: true })
    },
  }),
)
