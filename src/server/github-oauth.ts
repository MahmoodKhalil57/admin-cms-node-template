/** The in-browser GitHub connect flow. */
import type { NodeEnv } from './env'

export { signState, verifyState } from './oauth-state'

/**
 * Where GitHub sends the operator back.
 *
 * One URL for the whole fleet, on the dispatcher, exactly as Cloudflare does —
 * the node that started the flow is named in the signed `state` and the
 * dispatcher routes on it.
 *
 * A per-node path used to work by leaning on GitHub matching subdirectories of
 * the registered callback. An OAuth app has room for a single callback URL, so
 * that was the only way to serve many nodes from one registration, and it left
 * the whole connect flow resting on a matching rule we do not control.
 */
export function githubRedirectUri(env: NodeEnv): string {
  const base = (env.OAUTH_CALLBACK_BASE ?? env.PUBLIC_URL ?? '').replace(
    /\/+$/,
    '',
  )
  return `${base}/oauth/github/callback`
}

export function buildAuthorizeUrl(options: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  // Sites are public by design, so full `repo` access would be more than this
  // needs. `public_repo` covers creating one and enabling Pages on it.
  // `admin:repo_hook` is what lets the node register the push webhook that
  // keeps the site's declaration and this node's forms in step. Without it the
  // connection still works; only that guarantee is missing.
  url.searchParams.set('scope', 'public_repo admin:repo_hook')
  url.searchParams.set('state', options.state)
  return url.href
}

export class ExchangeFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExchangeFailed'
  }
}

/** Trade the callback's code for a token, then learn whose token it is. */
export async function exchangeCode(options: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<{ token: string; login: string }> {
  const tokenResponse = await fetch(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: options.code,
        redirect_uri: options.redirectUri,
      }),
    },
  )

  const tokenBody = (await tokenResponse.json().catch(() => null)) as {
    access_token?: string
    error_description?: string
  } | null

  if (!tokenBody?.access_token) {
    throw new ExchangeFailed(
      tokenBody?.error_description ?? 'GitHub refused the code.',
    )
  }

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'admin-cms-node',
    },
  })
  const user = (await userResponse.json().catch(() => null)) as {
    login?: string
  } | null
  if (!user?.login) {
    throw new ExchangeFailed('The new token could not identify its user.')
  }

  return { token: tokenBody.access_token, login: user.login }
}
