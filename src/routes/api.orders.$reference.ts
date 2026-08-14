import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { orderItems, orders } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'

/**
 * One order, by the reference the buyer was given.
 *
 * The return page reads this. It does not decide anything — a buyer arriving
 * here has not necessarily paid, and one who never arrives may well have. The
 * status comes from the webhook, and this only reports it.
 *
 * Addressed by reference rather than id, so this node's sales are not
 * enumerable by counting. A guest checkout has no account to check against, so
 * the reference is the credential — which is why it is nine random bytes and
 * not a number.
 */
export const Route = createFileRoute('/api/orders/$reference')(
  serverRoute(
    {
      GET: async ({ request, params }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('payments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const [order] = await db
          .select()
          .from(orders)
          .where(eq(orders.reference, params.reference))
          .limit(1)
        if (!order) return Response.json({ error: 'Not found' }, { status: 404 })

        // An order that belongs to an account is that account's. Knowing the
        // reference is enough for a guest, and not enough for somebody else's.
        if (order.buyerUserId) {
          const principal = await principalFrom(env, db, request)
          if (!principal || principal.userId !== order.buyerUserId) {
            return Response.json({ error: 'Not found' }, { status: 404 })
          }
        }

        const items = await db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id))

        return Response.json(
          {
            reference: order.reference,
            status: order.status,
            currency: order.currency,
            total: order.total,
            refundedTotal: order.refundedTotal,
            paidAt: order.paidAt,
            items: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitAmount: item.unitAmount,
              amount: item.amount,
            })),
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        )
      },
    },
    { gate: 'none' },
  ),
)
