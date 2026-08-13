/**
 * Self-authenticating OAuth `state`.
 *
 * OAuth needs a `state` parameter or an attacker can bind *their* account to
 * someone else's node (login CSRF). The usual defence is a cookie, but a
 * callback lands on a plain route with no session yet — so state carries its
 * own proof instead: a nonce and a timestamp, HMAC-signed with the OAuth client
 * secret. The callback verifies the signature and the freshness, and refuses
 * anything else.
 *
 * Shared by every provider the node connects to, because none of this is
 * specific to one.
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

/**
 * Signs a state, optionally carrying a payload.
 *
 * The payload exists because some providers match `redirect_uri` exactly, so
 * one callback URL has to serve the whole fleet — and then the state is the
 * only place left to say which node started the flow. It is signed along with
 * everything else, so a router may read it but not forge it.
 */
export async function signState(
  secret: string,
  payload = '',
  now?: number,
): Promise<string> {
  const timestamp = now ?? Math.floor(Date.now() / 1000)
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(12)))
  const body = `${base64Url(encoder.encode(payload))}.${nonce}.${timestamp}`
  return `${body}.${base64Url(await hmac(secret, body))}`
}

/**
 * Reads the payload out of a state without checking the signature.
 *
 * For routing only. Anything acting on the result must still verify — a state
 * that routes to the wrong node simply fails verification there.
 */
export function unsafeStatePayload(state: string): string | null {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  try {
    return new TextDecoder().decode(base64UrlDecode(parts[0]!))
  } catch {
    return null
  }
}

/** Null on any problem — a callback with bad state is simply refused. */
export async function verifyState(
  state: string,
  secret: string,
  now?: number,
): Promise<{ payload: string } | null> {
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [payloadPart, noncePart, timestampPart, signaturePart] = parts as [
    string,
    string,
    string,
    string,
  ]

  try {
    const expected = await hmac(
      secret,
      `${payloadPart}.${noncePart}.${timestampPart}`,
    )
    if (!sameBytes(expected, base64UrlDecode(signaturePart))) return null
  } catch {
    return null
  }

  const timestamp = Number(timestampPart)
  const current = now ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(timestamp)) return null
  // Reject the future too: a clock-skewed or replayed state is not fresh.
  const fresh =
    current - timestamp <= STATE_MAX_AGE_SECONDS && timestamp - current <= 60
  if (!fresh) return null

  try {
    return { payload: new TextDecoder().decode(base64UrlDecode(payloadPart)) }
  } catch {
    return null
  }
}
