import { createFileRoute } from '@tanstack/react-router'

import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import {
  buildAuthorizeUrl,
  cloudflareRedirectUri,
  signState,
} from '#/server/cloudflare-oauth'
import { getEnv } from '#/server/env'

export const Route = createFileRoute('/api/cloudflare/authorize')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (!env.CLOUDFLARE_CLIENT_ID || !env.CLOUDFLARE_CLIENT_SECRET) {
        return Response.json(
          { error: 'This node has no Cloudflare app configured.' },
          { status: 503 },
        )
      }

      return Response.redirect(
        buildAuthorizeUrl({
          clientId: env.CLOUDFLARE_CLIENT_ID,
          redirectUri: cloudflareRedirectUri(env),
          // The node's own id, so the shared callback knows where to come back
          // to. Signed, so it cannot be pointed at someone else's node.
          state: await signState(env.CLOUDFLARE_CLIENT_SECRET, env.NODE_ID),
        }),
        302,
      )
    },
  }),
)
