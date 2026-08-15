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
  return backTo(env, 'settings', query)
}

async function backTo(
  env: NodeEnv,
  screen: 'settings' | 'projects',
  query: string,
): Promise<Response> {
  const base = panelOrigin(env, await getSettings(getDb(env)))
  return Response.redirect(`${base}/admin/${screen}?${query}`, 302)
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
        /*
          Which screen the operator started from.

          Read before the state is verified, because a refusal has to land
          somewhere sensible even when it arrives without a usable one — and
          being bounced to Settings after trying to connect an account for
          projects is its own small confusion on top of the failure.
        */
        const wanted = await verifyState(
          state ?? '',
          env.CLOUDFLARE_CLIENT_SECRET,
        )
        const forProjects = wanted?.payload === `${env.NODE_ID}:infra`
        const screen = forProjects ? 'projects' : 'settings'
        const key = forProjects ? 'infra' : 'cloudflare'

        if (failure === 'access_denied') {
          return await backTo(env, screen, `${key}=declined`)
        }
        const detail = url.searchParams.get('error_description') ?? ''
        return await backTo(
          env,
          screen,
          `${key}=error&detail=${encodeURIComponent(
            `${failure}: ${detail}`.slice(0, 300),
          )}`,
        )
      }
      if (!code || !state) return await back(env, 'cloudflare=missing_code')
      const verified = await verifyState(state, env.CLOUDFLARE_CLIENT_SECRET)
      /*
        The state names a node and says which of the two grants this is.

        Cloudflare matches `redirect_uri` exactly, so one registered callback
        serves both the DNS consent and the much wider one that projects are
        built on. The suffix is what keeps them apart — without it, connecting
        a domain and handing over the keys to an account would be
        indistinguishable at the moment the browser comes back.
      */
      const payload = verified?.payload ?? ''
      const infra = payload === `${env.NODE_ID}:infra`
      if (!verified || (payload !== env.NODE_ID && !infra)) {
        return await back(env, 'cloudflare=bad_state')
      }

      try {
        const tokens = await exchangeCode({
          clientId: env.CLOUDFLARE_CLIENT_ID,
          clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
          code,
          redirectUri: cloudflareRedirectUri(env),
        })

        if (infra) {
          const { saveInfra } = await import('#/server/infra')
          const { whoami } = await import('#/server/projects/cloudflare')

          // Which account this grant is over. Recorded because it is the one
          // thing an operator has to be able to check — a project on the wrong
          // account is somebody else's bill.
          const who = await whoami(tokens.accessToken)
          const account = who?.accounts[0] ?? null

          await saveInfra(env, getDb(env), {
            provider: 'cloudflare',
            accessToken: tokens.accessToken,
            accountId: account?.id ?? null,
            accountName: account?.name ?? null,
            scopes: tokens.scopes ?? [],
            expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt * 1000) : null,
          })

          const base = panelOrigin(env, await getSettings(getDb(env)))
          const said = account
            ? 'infra=connected'
            : 'infra=connected&detail=' +
              encodeURIComponent(
                'Connected, but no account came back — the grant may be missing account.read.',
              )
          return Response.redirect(`${base}/admin/projects?${said}`, 302)
        }

        await saveCloudflare(getDb(env), tokens)
        return await back(env, 'cloudflare=connected')
      } catch (error) {
        if (infra) {
          const base = panelOrigin(env, await getSettings(getDb(env)))
          const detail = error instanceof Error ? error.message : 'exchange failed'
          return Response.redirect(
            `${base}/admin/projects?infra=error&detail=${encodeURIComponent(
              detail.slice(0, 300),
            )}`,
            302,
          )
        }
        return await back(env, 'cloudflare=exchange_failed')
      }
    },
  }),
)
