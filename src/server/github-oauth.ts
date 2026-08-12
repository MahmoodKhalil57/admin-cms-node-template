/**
 * The in-browser GitHub connect flow.
 *
 * OAuth needs a `state` parameter or an attacker can bind *their* GitHub account
 * to someone else's node (login CSRF). The usual defence is a cookie, but the
 * callback lands on a plain route with no session yet — so state is
 * self-authenticating instead: a nonce and a timestamp, HMAC-signed with the
 * OAuth client secret. The callback verifies the signature and the freshness,
 * and refuses anything else.
 */

const encoder = new TextEncoder()

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.codePointAt(0)!)
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(message)),
  )
}

/** Constant-time, so a wrong signature cannot be found a byte at a time. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!
  return difference === 0
}

export const STATE_MAX_AGE_SECONDS = 600

export async function signState(secret: string, now?: number): Promise<string> {
  const timestamp = now ?? Math.floor(Date.now() / 1000)
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(12)))
  const payload = `${nonce}.${timestamp}`
  return `${payload}.${base64Url(await hmac(secret, payload))}`
}

/** False on any problem — a callback with bad state is simply refused. */
export async function verifyState(
  state: string,
  secret: string,
  now?: number,
): Promise<boolean> {
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [noncePart, timestampPart, signaturePart] = parts as [
    string,
    string,
    string,
  ]

  try {
    const expected = await hmac(secret, `${noncePart}.${timestampPart}`)
    if (!sameBytes(expected, base64UrlDecode(signaturePart))) return false
  } catch {
    return false
  }

  const timestamp = Number(timestampPart)
  const current = now ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(timestamp)) return false
  // Reject the future too: a clock-skewed or replayed state is not fresh.
  return current - timestamp <= STATE_MAX_AGE_SECONDS && timestamp - current <= 60
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
  url.searchParams.set('scope', 'public_repo')
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
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
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
