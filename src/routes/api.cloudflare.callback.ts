import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import {
  cloudflareRedirectUri,
  exchangeCode,
  verifyState,
} from '#/server/cloudflare-oauth'
import { saveCloudflare } from '#/server/cloudflare-store'
import type { NodeEnv } from '#/server/env'
import { getEnv } from '#/server/env'

function back(env: NodeEnv, query: string): Response {
  const base = (env.PUBLIC_URL ?? '').replace(/\/+$/, '')
  return Response.redirect(`${base}/admin/settings?${query}`, 302)
}

/**
 * Where Cloudflare sends the operator back after granting DNS access.
 *
 * Session-free, like the GitHub callback: the browser arrives straight from
 * Cloudflare, so the signed `state` is the only thing vouching for it.
 */
export const Route = createFileRoute('/api/cloudflare/callback')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const url = new URL(request.url)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (!env.CLOUDFLARE_CLIENT_ID || !env.CLOUDFLARE_CLIENT_SECRET) {
        return back(env, 'cloudflare=unconfigured')
      }
      if (url.searchParams.get('error')) return back(env, 'cloudflare=declined')
      if (!code || !state) return back(env, 'cloudflare=missing_code')
      const verified = await verifyState(state, env.CLOUDFLARE_CLIENT_SECRET)
      // The state names a node; if it is not this one the flow was routed
      // wrongly and must not be honoured here.
      if (!verified || verified.payload !== env.NODE_ID) {
        return back(env, 'cloudflare=bad_state')
      }

      try {
        const tokens = await exchangeCode({
          clientId: env.CLOUDFLARE_CLIENT_ID,
          clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
          code,
          redirectUri: cloudflareRedirectUri(env),
        })
        await saveCloudflare(getDb(env), tokens)
        return back(env, 'cloudflare=connected')
      } catch {
        return back(env, 'cloudflare=exchange_failed')
      }
    },
  }),
)
