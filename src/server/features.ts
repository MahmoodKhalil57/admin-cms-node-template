import { eq, inArray } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { features } from '#/db/schema'
import { ALWAYS_ON, FEATURE_CATALOG } from '#/lib/feature-catalog'

/**
 * Which features are switched on, read from the node's own database.
 *
 * This is the authority. The admin UI hides a disabled feature's screens, but
 * that is only cosmetic — every request that touches gated data checks here,
 * because a hidden resource is still a reachable URL.
 *
 * One query per request. If that ever matters it can be cached in the node's KV
 * with a short TTL, at the cost of a toggle taking a few seconds to land.
 */
export async function getEnabledFeatures(db: NodeDb): Promise<Array<string>> {
  const known = FEATURE_CATALOG.map((feature) => feature.key)
  if (known.length === 0) return []

  const rows = await db
    .select()
    .from(features)
    .where(inArray(features.key, known))

  const enabled = rows.filter((row) => row.enabled).map((row) => row.key)

  /*
    The always-on ones, whatever their row says.

    Here rather than only in the seeder because this is the authority. A node
    provisioned by an older build has a row saying `payments: false`, and a
    check that trusted it would leave that node behaving as though a capability
    it now has does not exist. Deciding it here means the answer is right on the
    first request, before anything has had a chance to reconcile.
  */
  for (const key of ALWAYS_ON) {
    if (!enabled.includes(key)) enabled.push(key)
  }

  return enabled
}

/**
 * Makes sure every catalog entry has a row.
 *
 * Run at provision time and safe to re-run: a feature added by a later build
 * gets a row the next time this runs, defaulting to whatever the catalog says.
 * Existing rows are never overwritten — an operator's choice outlives a deploy.
 */
export async function ensureFeatureRows(db: NodeDb): Promise<number> {
  const existing = await db.select().from(features)
  const known = new Set(existing.map((row) => row.key))

  const missing = FEATURE_CATALOG.filter(
    (feature) => !known.has(feature.key),
  ).map((feature) => ({ key: feature.key, enabled: feature.defaultEnabled }))

  if (missing.length > 0) await db.insert(features).values(missing)

  // An always-on feature whose row says otherwise is corrected, so the screen
  // agrees with the behaviour. This is the one case where an operator's stored
  // choice is overruled — because it is no longer a choice.
  const wrong = existing.filter(
    (row) => ALWAYS_ON.includes(row.key) && !row.enabled,
  )
  for (const row of wrong) {
    await db
      .update(features)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(features.id, row.id))
  }

  return missing.length
}
