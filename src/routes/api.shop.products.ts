import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { paymentProviders, products } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'

/**
 * What is for sale, for a page that has to draw it.
 *
 * Public, and deliberately not the panel's `/api/products`: this returns only
 * published rows and only the fields a storefront needs. Nothing about which
 * file backs a product, how many downloads it allows, or what a vendor is owed
 * belongs on a page anybody can open.
 */
export const Route = createFileRoute('/api/shop/products')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('payments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const [provider] = await db.select().from(paymentProviders).limit(1)
        const rows = await db
          .select()
          .from(products)
          .where(eq(products.status, 'published'))
          .orderBy(desc(products.id))
          .limit(100)

        return Response.json(
          {
            currency: provider?.currency ?? 'USD',
            /** whether anything can actually be bought yet */
            open: Boolean(provider?.enabled),
            products: rows.map((row) => ({
              id: row.id,
              slug: row.slug,
              name: row.name,
              blurb: row.blurb,
              price: row.price,
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
