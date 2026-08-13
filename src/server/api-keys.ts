import { and, eq, isNull } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { apiKeys } from '#/db/schema'

/**
 * Keys that act as one of this node's users.
 *
 * A key is not a second permission system. It belongs to an account and carries
 * exactly that account's role — so a website is given a user with the
 * `frontend` role and a key to prove it is that user. Changing the role changes
 * every key it holds, and there is one place to look when asking what something
 * is allowed to do.
 *
 * The stored form is a hash. The secret exists once, in the response that mints
 * it: anything that can be read back out of the panel leaks with the panel.
 */

const PREFIX_BYTES = 4
const SECRET_BYTES = 24

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return hex(new Uint8Array(digest))
}

export interface MintedKey {
  id: number
  name: string
  prefix: string
  /** shown once, never stored */
  secret: string
}

/**
 * Permissions no key may carry, whoever holds them.
 *
 * A key is a long-lived secret that ends up in build output, CI logs and
 * browser bundles. Some things are worth that risk and some are not: reading
 * enquiries is a judgement, but handing out the ability to change who has
 * access, or what the node is, is not one a key should be able to make. The
 * account keeps these; its keys do not.
 */
export const KEY_FORBIDDEN = [
  'team:manage',
  'features:manage',
  'settings:write',
  'forms:delete',
]

export async function mintKey(
  db: NodeDb,
  userId: string,
  name: string,
  expiresAt?: Date | null,
  options: { allowedOrigins?: Array<string>; ratePerMinute?: number } = {},
): Promise<MintedKey> {
  const prefix = hex(crypto.getRandomValues(new Uint8Array(PREFIX_BYTES)))
  const secret = hex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))
  // The prefix travels in the key so a lookup does not have to hash every row,
  // and so a leaked key can be recognised in a log without being usable.
  const token = `ak_${prefix}_${secret}`

  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name: name.trim() || 'Untitled key',
      prefix,
      hash: await sha256(token),
      expiresAt: expiresAt ?? null,
      allowedOrigins: (options.allowedOrigins ?? [])
        .map((origin) => origin.trim().toLowerCase())
        .filter(Boolean),
      ratePerMinute: options.ratePerMinute ?? 0,
    })
    .returning()

  return { id: row!.id, name: row!.name, prefix, secret: token }
}

export interface KeyBearer {
  userId: string
  keyId: number
}

/** The origin a browser request came from, however it announced it. */
function originOf(request: Request): string {
  const origin = request.headers.get('origin')
  if (origin) return origin.toLowerCase()
  const referer = request.headers.get('referer')
  try {
    return referer ? new URL(referer).origin.toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * Whose key this is, if it is anyone's and still good.
 *
 * Returns null for anything wrong — unknown, revoked, expired, malformed —
 * without saying which. A caller holding a bad key learns only that it did not
 * work.
 */
export async function bearerFor(
  db: NodeDb,
  header: string | null,
  request?: Request,
): Promise<KeyBearer | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const parts = token.split('_')
  if (parts.length !== 3 || parts[0] !== 'ak') return null

  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, parts[1]!), isNull(apiKeys.revokedAt)))
    .limit(1)
  if (!row) return null

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null
  if ((await sha256(token)) !== row.hash) return null

  // Bound to an origin, a copy of this key is worth nothing anywhere else —
  // which is the only meaningful protection for one that ships in a page.
  const origins = row.allowedOrigins ?? []
  if (origins.length && request) {
    const origin = originOf(request)
    if (!origin || !origins.includes(origin)) return null
  }

  // Best-effort: knowing a key is still in use is worth more than the write.
  try {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
  } catch {
    /* ignore */
  }

  return { userId: row.userId, keyId: row.id }
}

export async function listKeys(db: NodeDb, userId: string) {
  return db.select().from(apiKeys).where(eq(apiKeys.userId, userId))
}

export async function revokeKey(db: NodeDb, id: number): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(apiKeys.id, id))
}
