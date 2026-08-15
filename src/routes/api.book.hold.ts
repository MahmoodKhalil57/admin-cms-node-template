import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'
import { holdSlot, serviceBySlug } from '#/server/booking/hold'
import { SLOT_MINUTES } from '#/server/booking/time'

/**
 * Taking a time off the diary.
 *
 * Public, like checkout and for the same reason: a booking page that required
 * an account would be a different product. A signed-in person is recognised so
 * the appointment appears on their account; a stranger gives a name and an
 * email.
 *
 * A paid service comes back `held` with an expiry, and the caller takes the
 * reference to `/api/checkout`. A free one comes back `confirmed`, because
 * there is nothing to wait for.
 *
 * **What this endpoint does not do is decide whether the slot was free.** It
 * asks, for the sake of a good message, and then the unique index on
 * `booking_slots` decides. Two people clicking the same 3pm both pass the
 * asking; only one passes the constraint.
 */
export const Route = createFileRoute('/api/book/hold')(
  serverRoute(
    {
      POST: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('appointments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const body = (await request.json().catch(() => ({}))) as {
          service?: string
          startsAt?: string
          name?: string
          email?: string
          note?: string
        }

        if (!body.service || !body.startsAt) {
          return Response.json(
            { error: 'A service and a time are both needed.' },
            { status: 422 },
          )
        }

        const startsAt = new Date(String(body.startsAt))
        if (Number.isNaN(startsAt.getTime())) {
          return Response.json({ error: 'That is not a time.' }, { status: 422 })
        }
        // Off the grid means it was never offered, whatever the diary says.
        // Caught here so the answer is "not a time we offer" rather than a
        // slot list that silently disagrees with what was asked for.
        if (startsAt.getTime() % (SLOT_MINUTES * 60_000) !== 0) {
          return Response.json(
            { error: 'That is not one of the times on offer.' },
            { status: 422 },
          )
        }

        const service = await serviceBySlug(db, String(body.service))
        if (!service || service.status !== 'published') {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const principal = await principalFrom(env, db, request)
        const email = body.email ?? principal?.email ?? null
        if (!email) {
          return Response.json(
            { error: 'An email address is needed to confirm the appointment.' },
            { status: 422 },
          )
        }

        const held = await holdSlot(db, service, {
          startsAt,
          buyerUserId: principal && !principal.viaKey ? principal.userId : null,
          buyerEmail: email,
          buyerName: body.name ?? principal?.name ?? null,
          note: body.note ?? null,
        })

        if (!held.ok) {
          // 409 for a slot somebody else took — the request was fine and the
          // world changed, which is what a conflict is. 422 for a time that
          // was never on offer.
          return Response.json(
            { error: held.message },
            { status: held.reason === 'taken' ? 409 : 422 },
          )
        }

        return Response.json({
          reference: held.booking.reference,
          status: held.booking.status,
          confirmed: held.confirmed,
          startsAt: held.booking.startsAt?.toISOString() ?? null,
          endsAt: held.booking.endsAt?.toISOString() ?? null,
          price: service.price,
          holdExpiresAt: held.booking.holdExpiresAt?.toISOString() ?? null,
        })
      },
    },
    { gate: 'none' },
  ),
)
