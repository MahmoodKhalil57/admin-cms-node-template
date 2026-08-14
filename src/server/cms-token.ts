import type { NodeEnv } from './env'

/**
 * The credential Sveltia holds.
 *
 * Sveltia's GitHub backend expects to be given a token and to send it back on
 * every call. That is the shape, and it is worth keeping — but the token it
 * gets must not be a GitHub one. A GitHub token in a browser is direct write
 * access to the repository, which is exactly what this whole arrangement exists
 * to avoid handing out.
 *
 * So it is given one of ours: a signed statement that says which account it
 * belongs to and when it stops being true. The proxy verifies it, resolves that
 * account's role and policies, and only then talks to GitHub — with the node's
 * own token, which never leaves the Worker.
 *
 * Signed rather than stored. There is nothing to look up, nothing to clean up,
 * and no table that has to be written to on every request. Short-lived instead
 * of revocable: a token good for eight hours is a smaller thing to get wrong
 * than a revocation list that has to be right.
 */

const TTL_SECONDS = 8 * 60 * 60

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function key(env: NodeEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

interface Claims {
  /** the account this token acts as */
  sub: string
  /** seconds since the epoch, after which it is not a token */
  exp: number
}

export async function mintCmsToken(
  env: NodeEnv,
  userId: string,
): Promise<string> {
  const claims: Claims = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  }
  const body = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(env),
    new TextEncoder().encode(body),
  )
  return `${body}.${base64url(new Uint8Array(signature))}`
}

/**
 * Whose token this is, if it is anyone's and still good.
 *
 * Null for anything wrong — unsigned, re-signed, expired, malformed — without
 * saying which. The verification is done by the crypto layer's own comparison,
 * so a forged signature fails in constant time rather than at the first wrong
 * byte.
 */
export async function verifyCmsToken(
  env: NodeEnv,
  token: string | null | undefined,
): Promise<string | null> {
  if (!token) return null
  const [body, signature] = token.split('.')
  if (!body || !signature) return null

  let valid: boolean
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await key(env),
      fromBase64url(signature) as unknown as ArrayBuffer,
      new TextEncoder().encode(body),
    )
  } catch {
    return null
  }
  if (!valid) return null

  try {
    const claims = JSON.parse(
      new TextDecoder().decode(fromBase64url(body)),
    ) as Claims
    if (!claims.sub || claims.exp * 1000 < Date.now()) return null
    return claims.sub
  } catch {
    return null
  }
}

/** The token from an `Authorization: token <t>` or `Bearer <t>` header. */
export function cmsTokenFrom(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''
  const match = /^(?:token|Bearer)\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}
