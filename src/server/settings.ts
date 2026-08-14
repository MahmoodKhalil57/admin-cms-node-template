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

export async function rememberZone(
  db: NodeDb,
  zone: string | null,
): Promise<void> {
  const current = await getSettings(db)
  if (current.dnsZone === zone) return
  await db
    .update(settings)
    .set({ dnsZone: zone })
    .where(eq(settings.id, current.id))
}

export async function saveCustomDomain(
  db: NodeDb,
  domain: string | null,
): Promise<NodeSettings> {
  const current = await getSettings(db)

  // Changing the domain invalidates every check made against the old one.
  const changed = domain !== current.customDomain

  const [updated] = await db
    .update(settings)
    .set({
      customDomain: domain,
      ...(changed
        ? { frontendVerified: false, apiVerified: false, dnsZone: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(settings.id, current.id))
    .returning()

  return updated
}

/**
 * Normalises what someone types into a bare registrable domain.
 *
 * Strips a scheme, a path and a leading `www.`, because someone pasting their
 * site's address means the domain, and storing `www.example.com` would put the
 * API on `api.www.example.com`.
 */
export function cleanDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '')
  if (trimmed === '') return null
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(trimmed) ? trimmed : null
}

/**
 * The address the outside world should use for this node's API.
 *
 * A verified custom domain wins; otherwise it is the dispatcher path form the
 * node was provisioned with. This is what gets written into a published site's
 * `config.js`, so the site follows the domain automatically once it verifies.
 */
export function publicApiBase(env: NodeEnv, current: NodeSettings): string {
  // Same origin as the website, under /api — one hostname, one record, one
  // certificate, and no cross-origin preflight on every form submission.
  if (current.customDomain && current.apiVerified) {
    return `https://${current.customDomain}/api`
  }
  return (env.PUBLIC_URL ?? '').replace(/\/+$/, '')
}

/**
 * Where the admin panel answers, for a link the browser will follow.
 *
 * Not the same as the API base. Without a custom domain the panel is reached
 * through the dispatcher at `…/n/<slug>/admin`, and `PUBLIC_URL` carries that
 * prefix — which is why a redirect built from it lands in the right place.
 *
 * It did not used to render there. The panel's router was compiled with a
 * basename of `/admin` and could not match its own URL under the prefix, so an
 * OAuth callback returned 200 and displayed the words "Not Found". The basename
 * is now read from the address bar instead; see `panelBasename`.
 */
export function panelOrigin(env: NodeEnv, current: NodeSettings): string {
  if (current.customDomain && current.apiVerified) {
    return `https://${current.customDomain}`
  }
  return (env.PUBLIC_URL ?? '').replace(/\/+$/, '')
}

export function originHost(env: NodeEnv): string {
  return env.ORIGIN_HOST ?? ''
}
