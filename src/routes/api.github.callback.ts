import { eq } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { features, githubConnections } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import type { NodeEnv } from '#/server/env'
import { getEnv } from '#/server/env'
import { exchangeCode, verifyState } from '#/server/github-oauth'

/**
 * Sends the browser back to the feature's own page.
 *
 * The row id is looked up rather than assumed: `github-pages` is not
 * necessarily row 2 on every node, since features are seeded in catalog order
 * and older nodes were seeded from a shorter catalog.
 */
async function back(
  env: NodeEnv,
  query: string,
  featureId?: number,
): Promise<Response> {
  const base = (env.PUBLIC_URL ?? '').replace(/\/+$/, '')
  const path = featureId ? `/features/${featureId}` : '/features'
  return Response.redirect(`${base}${path}?${query}`, 302)
}

async function githubFeatureId(env: NodeEnv): Promise<number | undefined> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(features)
      .where(eq(features.key, 'github-pages'))
      .limit(1)
    return row?.id
  } catch {
    return undefined
  }
}

/**
 * Where GitHub sends the user back.
 *
 * Deliberately session-free: the browser arrives here straight from GitHub, so
 * the only thing vouching for the request is the signed `state`.
 */
export const Route = createFileRoute('/api/github/callback')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const url = new URL(request.url)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const featureId = await githubFeatureId(env)

      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return back(env, 'github=unconfigured', featureId)
      }
      if (!code || !state) return back(env, 'github=missing_code', featureId)
      if (!(await verifyState(state, env.GITHUB_CLIENT_SECRET))) {
        return back(env, 'github=bad_state', featureId)
      }

      try {
        const { token, login } = await exchangeCode({
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          code,
          redirectUri: `${(env.PUBLIC_URL ?? '').replace(/\/+$/, '')}/api/github/callback`,
        })

        const db = getDb(env)
        // One connection per node: replace rather than accumulate.
        await db.delete(githubConnections)
        await db.insert(githubConnections).values({ login, accessToken: token })

        return back(env, 'github=connected', featureId)
      } catch {
        return back(env, 'github=exchange_failed', featureId)
      }
    },
  }),
)
