import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { githubRedirectUri } from '#/server/github-oauth'
import { getEnabledFeatures } from '#/server/features'
import { buildAuthorizeUrl, signState } from '#/server/github-oauth'

/**
 * Starts the GitHub connect flow.
 *
 * The redirect URI is one address for the whole fleet, on the dispatcher: an
 * OAuth app holds a single callback URL, and a per-node path only worked by
 * leaning on GitHub matching subdirectories of it. The node is named in the
 * signed state instead.
 *
 * It is built from the environment, not from the incoming request:
 * the dispatch Worker strips the `/n/<slug>` prefix before forwarding, so the
 * node cannot see its own public address in `request.url`.
 */
export const Route = createFileRoute('/api/github/authorize')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (!(await getEnabledFeatures(getDb(env))).includes('github-pages')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return Response.json(
          { error: 'This node has no GitHub app configured.' },
          { status: 503 },
        )
      }

      const redirectUri = githubRedirectUri(env)

      return Response.redirect(
        buildAuthorizeUrl({
          clientId: env.GITHUB_CLIENT_ID,
          redirectUri,
          // The node's own id, so the fleet-wide callback knows where to come
          // back to. Signed, so it cannot be pointed at someone else's node.
          state: await signState(env.GITHUB_CLIENT_SECRET, env.NODE_ID),
        }),
        302,
      )
    },
  }),
)
