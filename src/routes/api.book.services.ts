import { createFileRoute } from '@tanstack/react-router'
import { asc, eq, inArray } from 'drizzle-orm'

import { getDb } from '#/db'
import { paymentProviders, services, vendors } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'

/**
 * What can be booked, for a page that has to draw it.
 *
 * Public, and deliberately not the panel's `/api/services`: published rows
 * only, and only the fields a booking page needs. How far ahead the diary runs,
 * how long a hold lasts and what the buffer is are the operator's business.
 *
 * The vendor is included by name when there is one, because a marketplace page
 * has to say whose time it is selling. A single-vendor node returns null there
 * and the page ignores it — same payload either way, which is what keeps
 * features 3 and 4 the same feature.
 */
export const Route = createFileRoute('/api/book/services')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        const enabled = await getEnabledFeatures(db)
        if (!enabled.includes('appointments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const [provider] = await db.select().from(paymentProviders).limit(1)
        const rows = await db
          .select()
          .from(services)
          .where(eq(services.status, 'published'))
          .orderBy(asc(services.name))
          .limit(100)

        const vendorIds = [
          ...new Set(rows.map((row) => row.vendorId).filter(Boolean)),
        ] as Array<number>
        const sellers = new Map<number, { slug: string; name: string }>()
        if (vendorIds.length > 0) {
          const found = await db
            .select({ id: vendors.id, slug: vendors.slug, name: vendors.name, status: vendors.status })
            .from(vendors)
            .where(inArray(vendors.id, vendorIds))
          for (const row of found) {
            // A suspended vendor's times are not on offer, and the filter below
            // reads this map rather than a second query.
            if (row.status === 'active') {
              sellers.set(row.id, { slug: row.slug, name: row.name })
            }
          }
        }

        return Response.json(
          {
            currency: provider?.currency ?? 'USD',
            services: rows
              .filter((row) => !row.vendorId || sellers.has(row.vendorId))
              .map((row) => ({
                slug: row.slug,
                name: row.name,
                blurb: row.blurb,
                price: row.price,
                durationMinutes: row.durationMinutes,
                vendor: row.vendorId ? sellers.get(row.vendorId) ?? null : null,
              })),
          },
          {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=60',
            },
          },
        )
      },
    },
    { gate: 'none' },
  ),
)
