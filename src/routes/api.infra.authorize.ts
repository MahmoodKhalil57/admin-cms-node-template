import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import {
  buildAuthorizeUrl,
  cloudflareRedirectUri,
  signState,
} from '#/server/cloudflare-oauth'
import { infraScopes } from '#/server/infra'

/**
 * Sending the operator to Cloudflare to grant access to their own account.
 *
 * **A second consent, not a wider one.** The node may already hold a Cloudflare
 * grant for DNS. This asks for a different and much larger thing — creating
 * Workers, databases and namespaces — so it is a separate trip to a separate
 * consent screen, and somebody who connected Cloudflare to point a domain has
 * not silently agreed to this.
 *
 * Behind `infra:connect`, which is the permission the collaborator role
 * deliberately does not carry: choosing *whose* account projects land on is the
 * operator's decision, not a builder's.
 */
export const Route = createFileRoute('/api/infra/authorize')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)

      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      const denied = await requirePermission(env, db, request, 'infra:connect')
      if (denied) return denied

      if (!env.CLOUDFLARE_CLIENT_ID || !env.CLOUDFLARE_CLIENT_SECRET) {
        return Response.json(
          {
            error:
              'This platform has no Cloudflare application configured, so it cannot ask for access.',
          },
          { status: 503 },
        )
      }

      const scopes = infraScopes(env)
      const url = buildAuthorizeUrl({
        clientId: env.CLOUDFLARE_CLIENT_ID,
        redirectUri: cloudflareRedirectUri(env),
        // The suffix is what tells the shared callback which of the two
        // grants came back: Cloudflare matches one registered redirect URI
        // exactly, so both consents land on the same route.
        state: await signState(
          env.CLOUDFLARE_CLIENT_SECRET,
          `${env.NODE_ID}:infra`,
        ),
        scopes,
      })

      return Response.json({ url, scopes })
    },
  }),
)
