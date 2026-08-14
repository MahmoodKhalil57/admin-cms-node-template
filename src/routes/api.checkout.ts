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
import { orders } from '#/db/schema'

/**
 * Starting a checkout.
 *
 * Public, because a shop that only sells to people with accounts is a different
 * shop. A signed-in buyer is recognised and the order is attached to them,
 * which is what lets them find it again later; a stranger gives an email and
 * gets a receipt.
 *
 * **What is on sale is not taken from the request.** M3 will look prices up
 * from the products table; until that exists this accepts lines only from an
 * operator who could set the price anyway. A public endpoint that believed a
 * browser about what things cost would be a shop where everything is free.
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
          lines?: Array<Line>
          email?: string
          successUrl?: string
          cancelUrl?: string
        }

        // Until products exist, only somebody who may already set prices may
        // name one. This whole branch disappears in M3.
        const lines = Array.isArray(body.lines) ? body.lines : []
        if (!lines.length) {
          return Response.json({ error: 'Nothing to buy.' }, { status: 422 })
        }
        if (!principal || !principal.permissions.includes('forms:write')) {
          return Response.json(
            { error: 'Prices are not yet set by the caller.' },
            { status: 403 },
          )
        }
        for (const line of lines) {
          if (
            !Number.isInteger(line.unitAmount) ||
            line.unitAmount < 0 ||
            !Number.isInteger(line.quantity) ||
            line.quantity < 1
          ) {
            return Response.json(
              { error: 'Amounts are whole numbers of the smallest unit.' },
              { status: 422 },
            )
          }
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
