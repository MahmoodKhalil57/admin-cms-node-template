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
 * What is asked for when connecting an account.
 *
 * The naming is the permission group, kebab-cased, then the action — the same
 * shape the DNS grant uses. Not `account.read` or `account:read`, both of which
 * look plausible and are refused; the registration's own vocabulary is the only
 * authority, and it can be read back one scope at a time from the authorize
 * endpoint.
 *
 * **Cloudflare refuses the whole authorization if any requested scope is not on
 * the application's registration.** One scope too many does not degrade the
 * connection, it prevents it entirely — which is how the DNS grant failed for a
 * fortnight while reporting that the operator had declined. That is why this
 * list is only what is needed to *identify the account*, and why the scopes
 * needed to *build* are listed separately below.
 *
 * Splitting them means connecting succeeds on a registration that cannot yet
 * build, and the panel can say precisely which capability is missing. The
 * alternative — asking for everything — makes an incomplete registration look
 * like a broken product.
 */
export const INFRA_SCOPES = ['account-settings.read', 'user-details.read']

/**
 * What is needed to actually create anything.
 *
 * Absent from most registrations, including this platform's at the time of
 * writing, and unavailable to add until Cloudflare offers the groups in the
 * OAuth application's permission picker. The names follow the same convention
 * as everything else and should be confirmed against the registration rather
 * than trusted — asking for one that does not exist prevents connecting at all.
 *
 * There is **no R2 equivalent** in the vocabulary at any spelling, so a project
 * built on a delegated grant has no storage of its own regardless.
 */
export const BUILD_SCOPES = [
  'd1.write',
  'workers-scripts.write',
  /*
    Binding a database and a namespace to a script.

    Separate from writing the script itself in Cloudflare's model, and easy to
    miss: an upload carrying bindings is doing two things, and a grant that can
    only do the first fails at the point where the project would otherwise have
    started working.
  */
  'workers-scripts.bind',
  'workers-kv-storage.write',
]

/**
 * What the consent screen asks for.
 *
 * Both lists. They are kept apart because a registration missing any one of
 * them refuses the *whole* authorization — so when the build permissions were
 * unavailable, asking only for the account ones was what let an operator
 * connect at all and be told plainly what was still missing.
 *
 * Now that they are on the registration there is no reason to ask in two
 * stages: a connection that cannot build is not much use, and a second consent
 * screen for the same account is a worse experience than one honest one.
 */
export function infraScopes(env: NodeEnv): Array<string> {
  const configured = (env.CLOUDFLARE_INFRA_SCOPES ?? '').trim()
  if (configured) return configured.split(/[\s,]+/).filter(Boolean)
  return [...INFRA_SCOPES, ...BUILD_SCOPES]
}

/** Only what identifies the account — the fallback if building is unavailable. */
export function connectOnlyScopes(): Array<string> {
  return INFRA_SCOPES
}

/**
 * Whether a connection can build, and what it is short of.
 *
 * Read from what the provider actually granted rather than from what was asked
 * for. An empty grant list means Cloudflare said nothing about scopes, and the
 * honest reading of silence is "assume it can" — the alternative is refusing to
 * try on a connection that might work perfectly.
 */
export function missingForBuild(granted: Array<string>): Array<string> {
  if (granted.length === 0) return []
  return BUILD_SCOPES.filter((scope) => !granted.includes(scope))
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
