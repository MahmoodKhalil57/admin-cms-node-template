import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'
import { openOrder, providerConfig } from '#/server/payments/orders'
import type { Line } from '#/server/payments/orders'
import { providerFor } from '#/server/payments/stripe'
import { eq } from 'drizzle-orm'
import { orders, products } from '#/db/schema'

/** A cart, not a wholesale order. Both are bounds on an unauthenticated POST. */
const MAX_LINES = 20
const MAX_QTY = 99

/**
 * Starting a checkout.
 *
 * Public, because a shop that only sells to people with accounts is a different
 * shop. A signed-in buyer is recognised and the order is attached to them,
 * which is what lets them find it again later; a stranger gives an email and
 * gets a receipt.
 *
 * **What is on sale is not taken from the request.** The browser names product
 * ids and quantities; every price, name and vendor is read from the database.
 * A public endpoint that believed a browser about what things cost would be a
 * shop where everything is free, and it is worth being blunt about that because
 * the convenient version of this code is the broken one.
 */
export const Route = createFileRoute('/api/checkout')(
  serverRoute(
    {
      POST: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)

        if (!(await getEnabledFeatures(db)).includes('payments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const found = await providerConfig(env, db)
        if (!found) {
          return Response.json(
            { error: 'This shop is not taking payments yet.' },
            { status: 503 },
          )
        }
        const provider = providerFor(found.key)
        if (!provider) {
          return Response.json({ error: 'Unknown provider.' }, { status: 503 })
        }

        const principal = await principalFrom(env, db, request)
        const body = (await request.json().catch(() => ({}))) as {
          items?: Array<{ productId?: number; slug?: string; quantity?: number }>
          email?: string
          successUrl?: string
          cancelUrl?: string
        }

        const wanted = Array.isArray(body.items) ? body.items : []
        if (!wanted.length) {
          return Response.json({ error: 'Nothing to buy.' }, { status: 422 })
        }
        if (wanted.length > MAX_LINES) {
          return Response.json({ error: 'Too many items.' }, { status: 422 })
        }

        const lines: Array<Line> = []
        for (const item of wanted) {
          const quantity = Number(item.quantity ?? 1)
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
            return Response.json(
              { error: 'Quantities are whole numbers, at least one.' },
              { status: 422 },
            )
          }

          const [product] = await db
            .select()
            .from(products)
            .where(
              item.slug
                ? eq(products.slug, String(item.slug))
                : eq(products.id, Number(item.productId)),
            )
            .limit(1)

          // A draft or retired product is indistinguishable from one that never
          // existed, so an old link cannot be used to buy something withdrawn.
          if (!product || product.status !== 'published') {
            return Response.json(
              { error: 'That is not for sale.' },
              { status: 404 },
            )
          }

          lines.push({
            name: product.name,
            unitAmount: product.price,
            quantity,
            vendorId: product.vendorId,
            subjectType: 'product',
            subjectId: String(product.id),
          })
        }

        const origin = new URL(request.url).origin
        const order = await openOrder(db, {
          providerKey: found.key,
          currency: found.config.currency,
          lines,
          buyerUserId: principal && !principal.viaKey ? principal.userId : null,
          buyerEmail: body.email ?? principal?.email ?? null,
        })

        try {
          const session = await provider.createCheckout(found.config, {
            total: order.total,
            currency: found.config.currency,
            lines: lines.map((line) => ({
              name: line.name,
              unitAmount: line.unitAmount,
              quantity: line.quantity,
            })),
            buyerEmail: body.email ?? principal?.email ?? null,
            reference: order.reference,
            transferGroup: order.transferGroup,
            successUrl:
              body.successUrl ?? `${origin}/order?ref=${order.reference}`,
            cancelUrl: body.cancelUrl ?? `${origin}/`,
          })

          await db
            .update(orders)
            .set({ providerRef: session.providerRef })
            .where(eq(orders.id, order.id))

          return Response.json({
            reference: order.reference,
            total: order.total,
            currency: found.config.currency,
            url: session.url,
          })
        } catch (error) {
          // The order stays, marked failed. A pending row with no session is
          // indistinguishable from an abandoned checkout otherwise.
          await db
            .update(orders)
            .set({ status: 'failed' })
            .where(eq(orders.id, order.id))
          return Response.json(
            {
              error:
                error instanceof Error ? error.message : 'Checkout failed.',
              reference: order.reference,
            },
            { status: 502 },
          )
        }
      },
    },
    // Exempt from the profile gate: buying is not something to interrupt with
    // a form, and a guest has no profile to complete.
    { gate: 'none' },
  ),
)
