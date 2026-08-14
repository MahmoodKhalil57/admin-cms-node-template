import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { infraConnections } from '#/db/schema'
import type { NodeEnv } from '../env'
import { open, seal } from '../secrets'

/**
 * The operator's own accounts, for building on.
 *
 * Everything here exists to keep one promise: **a project created through this
 * costs us nothing and uses none of our keys.** The token in these rows belongs
 * to whoever connected it, the infrastructure it creates is on their account,
 * and the bill for it is theirs. Proxying any of this through master with our
 * credential would be easier and would quietly break the only property that
 * makes a whitelabel a whitelabel.
 */

/**
 * What creating infrastructure needs, as against pointing a domain.
 *
 * The node already has a Cloudflare connection for DNS, scoped to records and
 * routes. This asks for far more — the ability to create and destroy databases,
 * buckets and Workers — and it is a separate consent for exactly that reason.
 * Somebody who connected Cloudflare to point a domain has not agreed to this,
 * and quietly widening the first grant would mean deciding on their behalf.
 */
export const INFRA_SCOPES = [
  'account.read',
  'workers_scripts.write',
  'workers_kv_storage.write',
  'workers_r2.write',
  'd1.write',
  // So a project can be given a hostname on a domain they already own.
  'zone.read',
  'dns.write',
  'workers-routes.write',
]

export interface Connection {
  provider: string
  token: string
  accountId: string | null
  accountName: string | null
  login: string | null
  scopes: Array<string>
  expiresAt: Date | null
}

export async function connectionFor(
  env: NodeEnv,
  db: NodeDb,
  provider: string,
): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(infraConnections)
    .where(eq(infraConnections.provider, provider))
    .limit(1)
  if (!row) return null

  const token = await open(env, row.accessToken)
  if (!token) return null

  return {
    provider: row.provider,
    token,
    accountId: row.accountId,
    accountName: row.accountName,
    login: row.login,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt,
  }
}

export async function saveConnection(
  env: NodeEnv,
  db: NodeDb,
  input: {
    provider: string
    token: string
    accountId?: string | null
    accountName?: string | null
    login?: string | null
    scopes?: Array<string>
    expiresAt?: Date | null
  },
): Promise<void> {
  const values = {
    provider: input.provider,
    accessToken: await seal(env, input.token),
    accountId: input.accountId ?? null,
    accountName: input.accountName ?? null,
    login: input.login ?? null,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
  }

  const [existing] = await db
    .select()
    .from(infraConnections)
    .where(eq(infraConnections.provider, input.provider))
    .limit(1)

  if (existing) {
    await db
      .update(infraConnections)
      .set(values)
      .where(eq(infraConnections.id, existing.id))
  } else {
    await db.insert(infraConnections).values(values)
  }
}

export async function forgetConnection(
  db: NodeDb,
  provider: string,
): Promise<void> {
  await db.delete(infraConnections).where(eq(infraConnections.provider, provider))
}

/**
 * Nothing that leaves this Worker carries the token.
 *
 * `expiresAt` is included because Cloudflare grants no refresh token, so an
 * operator's connection stops working on a date — and being told beforehand is
 * the difference between reconnecting and discovering it mid-provision.
 */
export function redact(connection: Connection | null) {
  if (!connection) return { connected: false }
  return {
    connected: true,
    accountId: connection.accountId,
    accountName: connection.accountName,
    login: connection.login,
    scopes: connection.scopes,
    expiresAt: connection.expiresAt,
    /** whether it can still do what this feature needs */
    sufficient: INFRA_SCOPES.every(
      (scope) =>
        connection.provider !== 'cloudflare' ||
        connection.scopes.length === 0 ||
        connection.scopes.includes(scope),
    ),
  }
}
