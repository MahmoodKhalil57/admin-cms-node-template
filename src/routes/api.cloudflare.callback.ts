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
import { getSettings, panelOrigin } from '#/server/settings'

async function back(env: NodeEnv, query: string): Promise<Response> {
  const base = panelOrigin(env, await getSettings(getDb(env)))
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
        return await back(env, 'cloudflare=unconfigured')
      }
      /*
        Cloudflare's own answer, passed through.

        Every error used to become `declined`, so somebody who had declined
        nothing was told they had — and the real reason, which was a scope this
        OAuth client is not allowed to request, never reached anybody. A refusal
        that names the wrong cause is worse than one that says only that it
        failed.
      */
      const failure = url.searchParams.get('error')
      if (failure) {
        if (failure === 'access_denied') {
          return await back(env, 'cloudflare=declined')
        }
        const detail = url.searchParams.get('error_description') ?? ''
        return await back(
          env,
          `cloudflare=error&detail=${encodeURIComponent(
            `${failure}: ${detail}`.slice(0, 300),
          )}`,
        )
      }
      if (!code || !state) return await back(env, 'cloudflare=missing_code')
      const verified = await verifyState(state, env.CLOUDFLARE_CLIENT_SECRET)
      // The state names a node; if it is not this one the flow was routed
      // wrongly and must not be honoured here.
      if (!verified || verified.payload !== env.NODE_ID) {
        return await back(env, 'cloudflare=bad_state')
      }

      try {
        const tokens = await exchangeCode({
          clientId: env.CLOUDFLARE_CLIENT_ID,
          clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
          code,
          redirectUri: cloudflareRedirectUri(env),
        })
        await saveCloudflare(getDb(env), tokens)
        return await back(env, 'cloudflare=connected')
      } catch {
        return await back(env, 'cloudflare=exchange_failed')
      }
    },
  }),
)
