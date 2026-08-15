import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { meter, reportUsage } from '#/server/meter'
import { PRICE_LIST, periodOf } from '#/lib/price-list'

/**
 * What this node has used, and what it would cost.
 *
 * Readable by whoever may read the node's settings — this is a bill, and a bill
 * is the operator's business rather than the team's.
 *
 * `POST` sends it to master rather than waiting for the throttle. Useful when
 * somebody is looking at the number and wants it to be the one master has, and
 * harmless to press twice: master stores a period by replacing it.
 */
export const Route = createFileRoute('/api/usage')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const denied = await requirePermission(env, db, request, 'settings:read')
      if (denied) return denied

      const asked = new URL(request.url).searchParams.get('period')
      const period = asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : periodOf()

      return Response.json(
        {
          ...(await meter(env, db, period)),
          // The prices alongside the numbers, so a screen can say "5 credits
          // each" without a second request and without knowing them itself.
          priceList: PRICE_LIST,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    },

    POST: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const denied = await requirePermission(env, db, request, 'settings:write')
      if (denied) return denied

      const reading = await meter(env, db)
      const sent = await reportUsage(env, reading)
      return Response.json({
        period: reading.period,
        credits: reading.credits,
        ...sent,
      })
    },
  }),
)
