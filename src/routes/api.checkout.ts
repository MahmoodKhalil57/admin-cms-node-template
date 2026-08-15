import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'
import { openOrder, providerConfig } from '#/server/payments/orders'
import type { Line } from '#/server/payments/orders'
import { providerFor } from '#/server/payments/stripe'
import { eq, inArray } from 'drizzle-orm'
import { bookings, orders, products, services, vendors } from '#/db/schema'
import { commissionRates, splitLine } from '#/server/store/commission'
import { expireHolds } from '#/server/booking/hold'

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
          items?: Array<{
            productId?: number
            slug?: string
            quantity?: number
            /** a held booking's reference, from `/api/book/hold` */
            booking?: string
          }>
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

        // Anything somebody walked away from is off the diary before this
        // reads it, so an expired hold cannot be paid for.
        await expireHolds(db)

        const lines: Array<Line> = []
        /** the bookings this order is buying, attached once the order exists */
        const held: Array<number> = []
        for (const item of wanted) {
          const quantity = Number(item.quantity ?? 1)
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
            return Response.json(
              { error: 'Quantities are whole numbers, at least one.' },
              { status: 422 },
            )
          }

          /*
            An appointment, rather than a thing.

            The price is read from the service and the time from the hold, so a
            request cannot name its own. One is never more than one: a slot is
            a slot, and a quantity of three would mean three appointments at
            the same instant.
          */
          if (item.booking) {
            const [booking] = await db
              .select()
              .from(bookings)
              .where(eq(bookings.reference, String(item.booking)))
              .limit(1)
            if (!booking || booking.status !== 'held') {
              return Response.json(
                { error: 'That time is no longer held. Please pick another.' },
                { status: 409 },
              )
            }
            const [service] = await db
              .select()
              .from(services)
              .where(eq(services.id, booking.serviceId))
              .limit(1)
            if (!service || service.status !== 'published') {
              return Response.json(
                { error: 'That is not taking bookings.' },
                { status: 404 },
              )
            }
            held.push(booking.id)
            lines.push({
              // This is what the buyer reads on the provider's checkout page
              // and on their receipt, so it says the time in words rather than
              // as an ISO string. UTC, and it says so — the alternative is a
              // local time with no zone, which is the version somebody misses
              // an appointment over.
              name: `${service.name} — ${readableTime(booking.startsAt)}`,
              unitAmount: service.price,
              quantity: 1,
              vendorId: service.vendorId,
              subjectType: 'booking',
              subjectId: String(booking.id),
            })
            continue
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

        /*
          A suspended vendor keeps their rows and stops taking money.

          Checked here rather than by hiding their listings, because a listing
          is hidden from a storefront and a checkout is a POST somebody can
          repeat. A stale tab is the ordinary way this is reached, so the
          message says what happened rather than "not for sale".
        */
        const vendorIds = [
          ...new Set(
            lines
              .map((line) => line.vendorId)
              .filter((id): id is number => Boolean(id)),
          ),
        ]
        if (vendorIds.length > 0) {
          const rows = await db
            .select({ id: vendors.id, status: vendors.status, name: vendors.name })
            .from(vendors)
            .where(inArray(vendors.id, vendorIds))
          const shut = rows.find((row) => row.status !== 'active')
          if (shut) {
            return Response.json(
              { error: `${shut.name} is not selling at the moment.` },
              { status: 409 },
            )
          }
        }

        /*
          What the platform keeps.

          Worked out here, at the moment of sale, and written onto the order
          line — never recomputed later. A rate that changes next month must not
          change what a vendor was owed last month, and a refund six months on
          has to agree with the receipt.
        */
        const rates = await commissionRates(db, vendorIds)
        for (const line of lines) {
          const split = splitLine(
            line.unitAmount * line.quantity,
            rates.forVendor(line.vendorId ?? null),
          )
          line.vendorShare = split.vendorShare
          line.platformFee = split.platformFee
        }

        const origin = new URL(request.url).origin
        const order = await openOrder(db, {
          providerKey: found.key,
          currency: found.config.currency,
          lines,
          buyerUserId: principal && !principal.viaKey ? principal.userId : null,
          buyerEmail: body.email ?? principal?.email ?? null,
        })

        // Which order is paying for which appointment. Without this the webhook
        // has a paid order and no way to find the slot it was for, and the hold
        // quietly expires under somebody who has already been charged.
        if (held.length > 0) {
          await db
            .update(bookings)
            .set({ orderId: order.id })
            .where(inArray(bookings.id, held))
        }

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

/** An appointment's time, as a person would read it on a receipt. */
function readableTime(at: Date | null | undefined): string {
  if (!at) return ''
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)} UTC`
}
