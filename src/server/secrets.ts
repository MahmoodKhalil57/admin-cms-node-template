import type { NodeEnv } from './env'

/**
 * Secrets the node holds on somebody else's behalf.
 *
 * A Stripe secret key is not like the other things in this database. Every other
 * row is a fact about this node; this one is the ability to move money out of
 * the operator's business, and it sits in a file that gets exported, backed up
 * and copied between environments by people who are not thinking about it.
 *
 * So it is encrypted with a key derived from `BETTER_AUTH_SECRET`, which lives
 * in the Worker's environment and never in the database. What that buys is
 * specific and worth stating plainly: **a database on its own is not enough.**
 * Somebody who obtains a D1 export, a backup, or a copy of the file has
 * ciphertext. Somebody who can run code inside this Worker has both halves and
 * this stops nothing — no scheme stored beside its own key would.
 *
 * AES-GCM rather than a cipher without authentication, so a tampered ciphertext
 * fails to decrypt instead of decrypting to something else.
 */

const VERSION = 'v1'

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function base64(input: Uint8Array): string {
  return btoa(String.fromCharCode(...input))
}

function unbase64(input: string): Uint8Array {
  return Uint8Array.from(atob(input), (character) => character.charCodeAt(0))
}

/**
 * The key, derived rather than used directly.
 *
 * `BETTER_AUTH_SECRET` is already doing another job. Hashing it with a label
 * means this use cannot be turned into that one: a value encrypted here is not
 * a value signed there.
 */
async function key(env: NodeEnv): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    'SHA-256',
    bytes(`admin-cms:secrets:${env.BETTER_AUTH_SECRET}`) as unknown as ArrayBuffer,
  )
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** `v1.<iv>.<ciphertext>`, both base64. */
export async function seal(env: NodeEnv, plain: string): Promise<string> {
  if (!plain) return ''
  // A fresh nonce per value. Reusing one under AES-GCM is the mistake that
  // takes the scheme apart entirely, so it is generated here and never stored
  // anywhere it could be picked up again.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    bytes(plain) as unknown as ArrayBuffer,
  )
  return `${VERSION}.${base64(iv)}.${base64(new Uint8Array(sealed))}`
}

/**
 * Returns null for anything that will not open — wrong key, tampered bytes, or
 * a value from before this was encrypted at all. Null rather than throwing,
 * because every caller's answer is the same: treat the node as unconfigured.
 */
export async function open(
  env: NodeEnv,
  sealed: string | null | undefined,
): Promise<string | null> {
  if (!sealed) return null
  const [version, iv, body] = sealed.split('.')
  if (version !== VERSION || !iv || !body) return null

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(iv) as unknown as ArrayBuffer },
      await key(env),
      unbase64(body) as unknown as ArrayBuffer,
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/**
 * The last four characters, for a screen that has to prove a key is set without
 * showing it. Everything else about a stored secret stays in the Worker.
 */
export function hint(plain: string | null): string {
  return plain && plain.length > 4 ? `…${plain.slice(-4)}` : ''
}
