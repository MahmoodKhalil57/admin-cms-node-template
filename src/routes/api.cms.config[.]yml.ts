import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { principalForUserId } from '#/server/authz'
import { cmsTokenFrom, verifyCmsToken } from '#/server/cms-token'
import { buildConfig } from '#/server/cms-config'
import { ProxyError, refuse, resolveTarget } from '#/server/cms-proxy'
import { principalFrom } from '#/server/authz'

/**
 * The CMS configuration, built for whoever is asking.
 *
 * Sveltia fetches this itself rather than through its backend, so it arrives
 * with the session cookie rather than the CMS token — the admin page is on the
 * node's own origin, which is what makes that work. Either credential is
 * accepted, because the page loads before the token exists and reloads after.
 */
export const Route = createFileRoute('/api/cms/config.yml')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)

        const bySession = await principalFrom(env, db, request)
        const userId = await verifyCmsToken(env, cmsTokenFrom(request))
        const principal =
          bySession ?? (userId ? await principalForUserId(env, db, userId) : null)

        if (!principal) {
          return refuse(401, 'Sign in to open the CMS.')
        }

        try {
          const target = await resolveTarget(
            db,
            // Any path under the connected repo resolves the same connection;
            // this one exists only to satisfy the check.
            await repoPath(db),
          )
          const { getEnabledFeatures } = await import('#/server/features')
          const yaml = await buildConfig(
            target,
            principal,
            request,
            await getEnabledFeatures(db),
          )
          return new Response(yaml, {
            headers: {
              'Content-Type': 'application/yaml; charset=utf-8',
              // Built per account, so nothing between here and the browser may
              // keep a copy for the next one.
              'Cache-Control': 'private, no-store',
            },
          })
        } catch (error) {
          if (error instanceof ProxyError) {
            return refuse(error.status, error.message)
          }
          return refuse(
            500,
            error instanceof Error ? error.message : 'Could not build the CMS.',
          )
        }
      },
    },
    // Exempt from the profile gate: the CMS has to be able to draw itself
    // before it can show anybody a form asking for their name.
    { gate: 'none' },
  ),
)

/** The repo prefix `resolveTarget` expects, from the node's own connection. */
async function repoPath(db: Parameters<typeof resolveTarget>[0]) {
  const { currentConnection } = await import('#/server/github-store')
  const connection = await currentConnection(db)
  return `/repos/${connection?.repoOwner}/${connection?.repoName}`
}
