import { desc, eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { cloudflareConnections } from '#/db/schema'
import type { NodeEnv } from './env'
import { refreshTokens } from './cloudflare-oauth'

export async function currentCloudflare(db: NodeDb) {
  const [row] = await db
    .select()
    .from(cloudflareConnections)
    .orderBy(desc(cloudflareConnections.id))
    .limit(1)
  return row
}

export async function saveCloudflare(
  db: NodeDb,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: number | null },
) {
  // One connection per node: replace rather than accumulate.
  await db.delete(cloudflareConnections)
  await db.insert(cloudflareConnections).values(tokens)
}

/**
 * A usable access token, refreshed if it has expired.
 *
 * Consent may have been granted long before the operator gets around to setting
 * the domain up, so an expired token should renew itself rather than send them
 * back through the connect flow.
 */
export async function usableCloudflareToken(
  db: NodeDb,
  env: NodeEnv,
): Promise<string | null> {
  const connection = await currentCloudflare(db)
  if (!connection) return null

  const now = Math.floor(Date.now() / 1000)
  // 60s of slack, so a token that expires mid-request is renewed first.
  const stillValid = !connection.expiresAt || connection.expiresAt - 60 > now
  if (stillValid) return connection.accessToken

  if (
    !connection.refreshToken ||
    !env.CLOUDFLARE_CLIENT_ID ||
    !env.CLOUDFLARE_CLIENT_SECRET
  ) {
    return null
  }

  try {
    const refreshed = await refreshTokens({
      clientId: env.CLOUDFLARE_CLIENT_ID,
      clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
      refreshToken: connection.refreshToken,
    })
    await db
      .update(cloudflareConnections)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? connection.refreshToken,
        expiresAt: refreshed.expiresAt,
      })
      .where(eq(cloudflareConnections.id, connection.id))
    return refreshed.accessToken
  } catch {
    return null
  }
}
