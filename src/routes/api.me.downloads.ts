import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { entitlements, orders, products } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'
import { signDownload } from '#/server/store/fulfil'

/**
 * What this account has bought, and links to fetch it again.
 *
 * The answer to "the email went to spam", which is the most common support
 * question any shop selling files ever gets. Links are minted fresh on each
 * read rather than stored, so one that expired in an inbox is replaced simply
 * by opening this page — the entitlement is the durable thing, and the link
 * was only ever a way to point at it.
 *
 * A guest purchase has no account and cannot appear here. Their email is the
 * only route back, which is worth knowing when somebody asks.
 */
export const Route = createFileRoute('/api/me/downloads')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('payments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const principal = await principalFrom(env, db, request)
        if (!principal) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const rows = await db
          .select({
            id: entitlements.id,
            productName: products.name,
            downloadsUsed: entitlements.downloadsUsed,
            downloadLimit: entitlements.downloadLimit,
            expiresAt: entitlements.expiresAt,
            revokedAt: entitlements.revokedAt,
            reference: orders.reference,
          })
          .from(entitlements)
          .leftJoin(products, eq(products.id, entitlements.productId))
          .leftJoin(orders, eq(orders.id, entitlements.orderId))
          .where(eq(entitlements.buyerUserId, principal.userId))
          .orderBy(desc(entitlements.id))
          .limit(100)

        const origin = new URL(request.url).origin
        const downloads = await Promise.all(
          rows.map(async (row) => {
            const live =
              !row.revokedAt &&
              row.downloadsUsed < row.downloadLimit &&
              (!row.expiresAt || row.expiresAt.getTime() > Date.now())

            return {
              name: row.productName,
              reference: row.reference,
              used: row.downloadsUsed,
              of: row.downloadLimit,
              expiresAt: row.expiresAt,
              available: live,
              url: live
                ? `${origin}/api/download/${await signDownload(
                    env,
                    row.id,
                    Math.floor(
                      (row.expiresAt?.getTime() ?? Date.now() + 86_400_000) / 1000,
                    ),
                  )}`
                : null,
            }
          }),
        )

        return Response.json(
          { downloads },
          { headers: { 'Cache-Control': 'private, no-store' } },
        )
      },
    },
    // Exempt from the profile gate: somebody chasing a file they paid for is
    // not the moment to ask for their surname.
    { gate: 'none' },
  ),
)
