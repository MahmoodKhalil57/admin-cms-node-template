import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { expireHolds, serviceBySlug } from '#/server/booking/hold'
import { slotsFor } from '#/server/booking/slots'

/** A month at a time. A page that wants a year asks twelve times. */
const MAX_RANGE_DAYS = 62

/**
 * When a service is free, as instants.
 *
 * Always UTC, always ISO 8601. The page renders them in whatever timezone the
 * person reading is in, which is the browser's job and not ours — and it is
 * why the answer must not be local times: "2pm" is meaningless to somebody in
 * another country, and an appointment booked from a plane still has to happen
 * at one specific moment.
 */
export const Route = createFileRoute('/api/book/slots')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('appointments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const url = new URL(request.url)
        const slug = url.searchParams.get('service')
        if (!slug) {
          return Response.json({ error: 'Which service?' }, { status: 422 })
        }

        const service = await serviceBySlug(db, slug)
        if (!service || service.status !== 'published') {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const now = new Date()
        const from = parseDate(url.searchParams.get('from')) ?? now
        const asked = parseDate(url.searchParams.get('to'))
        const to = new Date(
          Math.min(
            (asked ?? new Date(from.getTime() + 14 * 86_400_000)).getTime(),
            from.getTime() + MAX_RANGE_DAYS * 86_400_000,
          ),
        )

        // Whatever nobody came back for goes back on the diary first, so this
        // shows what is genuinely free rather than what was free an hour ago.
        await expireHolds(db, now)

        const slots = await slotsFor(db, service, { from, to, now })

        return Response.json(
          {
            service: {
              slug: service.slug,
              name: service.name,
              price: service.price,
              durationMinutes: service.durationMinutes,
            },
            from: from.toISOString(),
            to: to.toISOString(),
            slots,
          },
          {
            headers: {
              'Access-Control-Allow-Origin': '*',
              // Short, and deliberately not zero: a slot list is stale the
              // moment somebody else books, and the hold endpoint is what
              // decides. Caching for a few seconds spares the diary a query
              // per keystroke without making the answer meaningfully older.
              'Cache-Control': 'public, max-age=15',
            },
          },
        )
      },
    },
    { gate: 'none' },
  ),
)

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}
