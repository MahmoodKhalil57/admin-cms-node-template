import { and, eq, isNull } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { apiKeys } from '#/db/schema'
import type { RoleCondition } from '#/db/schema'
import type { Principal } from './authz'

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
 * Raised when something holding a key tries to make another one.
 *
 * A separate type rather than a returned message because there is no sensible
 * way to carry on from it, and a caller that forgets to check gets an exception
 * rather than a key.
 */
export class KeyMintRefused extends Error {
  constructor() {
    super('A key cannot mint another key.')
  }
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

/**
 * Mints a key, and refuses to do it for something that is already one.
 *
 * A key may narrow itself when it is made, and that scope is the second of two
 * gates. Two is a number worth keeping. If a key could mint another, the chain
 * would be unbounded: every check would have to walk back through however many
 * parents a key happened to have, every key row would need to remember which
 * one made it, and revoking one would mean finding everything descended from
 * it. None of that is hard so much as it is a permanent tax on being right.
 *
 * So the depth is fixed at the only place a key can be created. A person mints
 * keys; a key does not. An agent that needs different access asks the person
 * who gave it one, which is the conversation that should be happening anyway.
 *
 * Taking the minter rather than a flag means a caller cannot forget to decide —
 * there is no way to reach this function without saying who is asking.
 */
export async function mintKey(
  db: NodeDb,
  mintedBy: Principal,
  userId: string,
  name: string,
  expiresAt?: Date | null,
  options: {
    allowedOrigins?: Array<string>
    ratePerMinute?: number
    /** the second gate; omit for a key the account's own grant alone narrows */
    scope?: {
      permissions?: Array<string> | null
      conditions?: Record<string, RoleCondition>
      policies?: Array<string>
    }
  } = {},
): Promise<MintedKey> {
  // The one place a key comes into existence, so the one place this has to be
  // said. Checked before anything is generated: a refused mint leaves no trace.
  if (mintedBy.viaKey) throw new KeyMintRefused()

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
      scopePermissions: options.scope?.permissions ?? null,
      scopeConditions: options.scope?.conditions ?? {},
      scopePolicies: options.scope?.policies ?? [],
    })
    .returning()

  return { id: row!.id, name: row!.name, prefix, secret: token }
}

export interface KeyBearer {
  userId: string
  keyId: number
  /**
   * The second gate, as the holder wrote it.
   *
   * `null` permissions means the key was minted without one, and the account's
   * own grant is the only thing narrowing it.
   */
  scope: {
    permissions: Array<string> | null
    conditions: Record<string, RoleCondition>
    policies: Array<string>
  }
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

  return {
    userId: row.userId,
    keyId: row.id,
    scope: {
      permissions: row.scopePermissions ?? null,
      conditions: row.scopeConditions ?? {},
      policies: row.scopePolicies ?? [],
    },
  }
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
