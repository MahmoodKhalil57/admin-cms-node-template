import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { settings } from '#/db/schema'
import type { NodeEnv } from './env'

export type NodeSettings = typeof settings.$inferSelect

/** The settings row, created on first read so callers never handle a null. */
export async function getSettings(db: NodeDb): Promise<NodeSettings> {
  const [existing] = await db.select().from(settings).limit(1)
  if (existing) return existing

  const [created] = await db.insert(settings).values({}).returning()
  return created
}

export async function saveSettings(
  db: NodeDb,
  patch: Partial<Pick<NodeSettings, 'apiDomain' | 'frontendDomain'>>,
): Promise<NodeSettings> {
  const current = await getSettings(db)

  // Changing a domain invalidates the check that was done against the old one.
  const apiChanged =
    patch.apiDomain !== undefined && patch.apiDomain !== current.apiDomain
  const frontendChanged =
    patch.frontendDomain !== undefined &&
    patch.frontendDomain !== current.frontendDomain

  const [updated] = await db
    .update(settings)
    .set({
      ...patch,
      ...(apiChanged ? { apiVerified: false } : {}),
      ...(frontendChanged ? { frontendVerified: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(settings.id, current.id))
    .returning()

  return updated
}

/** Normalises what someone types into a bare hostname. */
export function cleanDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
  if (trimmed === '') return null
  // Reject anything that is not plausibly a hostname rather than storing it and
  // failing later at the DNS lookup.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed) ? trimmed : null
}

/**
 * The address the outside world should use for this node's API.
 *
 * A verified custom domain wins; otherwise it is the dispatcher path form the
 * node was provisioned with. This is what gets written into a published site's
 * `config.js`, so the site follows the domain automatically.
 */
export function publicApiBase(env: NodeEnv, current: NodeSettings): string {
  if (current.apiDomain && current.apiVerified) {
    return `https://${current.apiDomain}`
  }
  return (env.PUBLIC_URL ?? '').replace(/\/+$/, '')
}
