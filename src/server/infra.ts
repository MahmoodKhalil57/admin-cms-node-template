import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { infraConnections } from '#/db/schema'
import type { NodeEnv } from './env'
import { open, seal } from './secrets'

/**
 * The accounts this node builds projects on.
 *
 * **A second connection, not a wider one.** The node already has a Cloudflare
 * grant for DNS, scoped to `dns.write` and `zone.read`. Creating infrastructure
 * needs far more — Workers, D1, KV, account read — and widening the existing
 * consent would mean somebody who connected Cloudflare to point a domain had
 * silently granted the ability to create and delete infrastructure on their
 * account. Consent that was never asked for is not consent.
 *
 * So: two connections, two consent screens, and the wider one is only asked for
 * when this feature is switched on.
 *
 * The whole point of what is stored here is *whose* account it is. Projects
 * built through this cost the platform nothing and use none of its keys — the
 * bill lands on the operator, on their own Cloudflare account, which is what
 * makes a whitelabel possible at all.
 */

export type InfraProvider = 'cloudflare' | 'github'

/**
 * What creating infrastructure needs.
 *
 * Dotted, matching the DNS connection, because that is the vocabulary this
 * OAuth client's registration is written in — Cloudflare's own first-party
 * tooling uses a colon form for the same capabilities, which is a trap worth
 * naming since both look plausible in a config file.
 *
 * **Cloudflare refuses the whole authorization if any requested scope is not on
 * the app's registration.** One scope too many does not degrade the connection,
 * it prevents it entirely — which is exactly how the DNS connection failed for
 * a fortnight while reporting that the operator had declined. So this list is
 * overridable from the environment: adding a scope to the registration and
 * naming it here is all it takes, with no code change.
 *
 * **There is no R2 scope.** Cloudflare's OAuth vocabulary has no equivalent of
 * `r2:write` at all, so a project built this way cannot be given a bucket of
 * its own. Provisioning carries on without one and says so — a project with no
 * file storage is a real thing that mostly works, and a project that refused to
 * exist because one binding was unavailable is not.
 */
export const INFRA_SCOPES = [
  'account.read',
  'user.read',
  'workers.write',
  'workers_scripts.write',
  'workers_kv.write',
  'd1.write',
]

export function infraScopes(env: NodeEnv): Array<string> {
  const configured = (env.CLOUDFLARE_INFRA_SCOPES ?? '').trim()
  return configured ? configured.split(/[\s,]+/).filter(Boolean) : INFRA_SCOPES
}

export interface InfraConnection {
  provider: InfraProvider
  accountId: string | null
  accountName: string | null
  login: string | null
  scopes: Array<string>
  expiresAt: Date | null
  /** whether the grant has already run out */
  expired: boolean
}

export async function currentInfra(
  db: NodeDb,
  provider: InfraProvider,
): Promise<InfraConnection | null> {
  const [row] = await db
    .select()
    .from(infraConnections)
    .where(eq(infraConnections.provider, provider))
    .limit(1)
  if (!row) return null

  return {
    provider,
    accountId: row.accountId,
    accountName: row.accountName,
    login: row.login,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt ?? null,
    expired: Boolean(row.expiresAt && row.expiresAt.getTime() < Date.now()),
  }
}

/**
 * The token itself, which nothing outside this file should hold onto.
 *
 * Returns null on an expired grant rather than a token that will 401 halfway
 * through creating a database. Cloudflare grants no refresh token — it does not
 * offer `offline_access` — so reconnecting is the only renewal there is, and
 * provisioning has to fail before it starts rather than midway.
 */
export async function infraToken(
  env: NodeEnv,
  db: NodeDb,
  provider: InfraProvider,
): Promise<{ token: string; accountId: string | null } | null> {
  const [row] = await db
    .select()
    .from(infraConnections)
    .where(eq(infraConnections.provider, provider))
    .limit(1)
  if (!row) return null
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null

  const token = await open(env, row.accessToken)
  if (!token) return null
  return { token, accountId: row.accountId }
}

export async function saveInfra(
  env: NodeEnv,
  db: NodeDb,
  input: {
    provider: InfraProvider
    accessToken: string
    accountId?: string | null
    accountName?: string | null
    login?: string | null
    scopes?: Array<string>
    expiresAt?: Date | null
  },
): Promise<void> {
  const values = {
    provider: input.provider,
    accessToken: await seal(env, input.accessToken),
    accountId: input.accountId ?? null,
    accountName: input.accountName ?? null,
    login: input.login ?? null,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
  }

  // One connection per provider. Reconnecting replaces rather than adds,
  // because two grants for one provider is two answers to "whose account".
  await db
    .insert(infraConnections)
    .values(values)
    .onConflictDoUpdate({
      target: infraConnections.provider,
      set: {
        accessToken: values.accessToken,
        accountId: values.accountId,
        accountName: values.accountName,
        login: values.login,
        scopes: values.scopes,
        expiresAt: values.expiresAt,
      },
    })
}

export async function forgetInfra(
  db: NodeDb,
  provider: InfraProvider,
): Promise<void> {
  await db.delete(infraConnections).where(eq(infraConnections.provider, provider))
}
