export { signState, verifyState } from './oauth-state'

import type { NodeEnv } from './env'

/**
 * The one callback URL registered with Cloudflare.
 *
 * Cloudflare matches `redirect_uri` exactly, so it cannot contain a node's
 * slug — the dispatch Worker receives this and forwards to whichever node the
 * signed state names. Both the authorize call and the token exchange must send
 * the identical string.
 */
export function cloudflareRedirectUri(env: NodeEnv): string {
  const base = (env.OAUTH_CALLBACK_BASE ?? '').replace(/\/+$/, '')
  return `${base}/oauth/cloudflare/callback`
}

/**
 * Cloudflare's OAuth endpoints.
 *
 * Cloudflare supports only the Authorization Code flow for third-party clients.
 * A node is a Worker with a real secret, so it authenticates as a confidential
 * client and PKCE is optional.
 */
const AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth'
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'

/**
 * What the node asks for.
 *
 * `dns.write` to create the records and `zone.read` to find which zone the
 * domain belongs to — nothing else. A consent screen that asks for more than it
 * needs is one people are right to refuse.
 *
 * No `offline_access`: Cloudflare does not offer it as a grantable scope, and
 * asking is rejected outright with `invalid_scope`. So there is no refresh
 * token, and an expired grant means reconnecting rather than renewing silently.
 * The refresh path below stays because Cloudflare may still return a refresh
 * token, and using one if offered costs nothing.
 */
export const CLOUDFLARE_SCOPES = [
  'dns.write',
  'zone.read',
  // The API hostname is served by a Worker, which needs a route as well as a
  // record — a DNS record alone reaches Cloudflare and gets nothing back.
  'workers-routes.write',
]

export function buildAuthorizeUrl(options: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('scope', CLOUDFLARE_SCOPES.join(' '))
  url.searchParams.set('state', options.state)
  return url.href
}

export class ExchangeFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExchangeFailed'
  }
}

export interface CloudflareTokens {
  accessToken: string
  refreshToken: string | null
  /** epoch seconds, or null when Cloudflare does not say */
  expiresAt: number | null
}

async function tokenRequest(
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<CloudflareTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      // client_secret_basic: the secret goes in the header, never the body.
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams(body).toString(),
  })

  const parsed = (await response.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  } | null

  if (!parsed?.access_token) {
    throw new ExchangeFailed(
      parsed?.error_description ?? parsed?.error ?? 'Cloudflare refused the request.',
    )
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresAt: parsed.expires_in
      ? Math.floor(Date.now() / 1000) + parsed.expires_in
      : null,
  }
}

export async function exchangeCode(options: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<CloudflareTokens> {
  return tokenRequest(options.clientId, options.clientSecret, {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
  })
}

/**
 * Trades a refresh token for a fresh access token.
 *
 * Worth having rather than making the operator reconnect: they may set the
 * domain up long after granting consent.
 */
export async function refreshTokens(options: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): Promise<CloudflareTokens> {
  return tokenRequest(options.clientId, options.clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  })
}
