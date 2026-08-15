import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { bookings, services } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { allows, can, principalFrom } from '#/server/authz'
import { cancelBooking } from '#/server/booking/hold'

/**
 * One appointment, by the reference the buyer was given.
 *
 * Read the same way an order is: a reference is nine random bytes, which is
 * enough of a credential for a guest and never enough for somebody else's
 * account. A booking attached to an account is that account's.
 *
 * `DELETE` calls it off. Two people may: whoever it belongs to, and whoever
 * runs the diary — and the second is scoped, so on a marketplace a vendor can
 * cancel their own appointments and not another vendor's. That check is the
 * same `allows` every other row in this node goes through, reading the
 * booking's own `vendorId`.
 */
export const Route = createFileRoute('/api/bookings/$reference')(
  serverRoute(
    {
      GET: async ({ request, params }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('appointments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const found = await load(db, params.reference)
        if (!found) return Response.json({ error: 'Not found' }, { status: 404 })

        if (found.booking.buyerUserId) {
          const principal = await principalFrom(env, db, request)
          const mine = principal?.userId === found.booking.buyerUserId
          const runsIt =
            principal &&
            can(principal, 'bookings:read') &&
            allows(principal, 'bookings:read', found.booking)
          if (!mine && !runsIt) {
            return Response.json({ error: 'Not found' }, { status: 404 })
          }
        }

        return Response.json(
          {
            reference: found.booking.reference,
            status: found.booking.status,
            startsAt: found.booking.startsAt?.toISOString() ?? null,
            endsAt: found.booking.endsAt?.toISOString() ?? null,
            holdExpiresAt: found.booking.holdExpiresAt?.toISOString() ?? null,
            service: {
              slug: found.service?.slug ?? null,
              name: found.service?.name ?? null,
              price: found.service?.price ?? 0,
            },
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        )
      },

      DELETE: async ({ request, params }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('appointments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const found = await load(db, params.reference)
        if (!found) return Response.json({ error: 'Not found' }, { status: 404 })

        const principal = await principalFrom(env, db, request)
        const mine =
          Boolean(found.booking.buyerUserId) &&
          principal?.userId === found.booking.buyerUserId
        const runsIt =
          principal &&
          can(principal, 'bookings:manage') &&
          allows(principal, 'bookings:manage', found.booking)

        if (!mine && !runsIt) {
          return Response.json(
            {
              error: 'Not allowed. This needs "bookings:manage".',
              message: 'Not allowed. This needs "bookings:manage".',
            },
            { status: 403 },
          )
        }

        const cancelled = await cancelBooking(
          db,
          found.booking.id,
          mine ? 'buyer' : 'operator',
        )

        /*
          Cancelling gives the time back; it does not give the money back.

          Refunding is a decision somebody makes through the provider, and
          quietly issuing one here would mean a button in a booking page could
          move money. The two are connected in the other direction — a refund
          cancels the appointment — because that one is unambiguous.
        */
        return Response.json({
          reference: found.booking.reference,
          status: cancelled ? 'cancelled' : found.booking.status,
          cancelled,
          refunded: false,
        })
      },
    },
    { gate: 'none' },
  ),
)

async function load(db: ReturnType<typeof getDb>, reference: string) {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.reference, reference))
    .limit(1)
  if (!booking) return null

  const [service] = await db
    .select()
    .from(services)
    .where(eq(services.id, booking.serviceId))
    .limit(1)
  return { booking, service: service ?? null }
}
