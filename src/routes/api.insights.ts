import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom, requirePermission } from '#/server/authz'
import { insightsFor } from '#/server/insights'
import { maybeReport } from '#/server/meter'

/**
 * The numbers, for whoever is asking.
 *
 * Gated on `instrumentation` — which decides who may *read* the log, never
 * whether it is written. A node that recorded nothing until somebody switched
 * this on would have nothing to show them at the moment they asked, which is
 * the one failure the whole feature exists to avoid.
 */
export const Route = createFileRoute('/api/insights')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)

      if (!(await getEnabledFeatures(db)).includes('instrumentation')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const denied = await requirePermission(env, db, request, 'events:read')
      if (denied) return denied

      const principal = (await principalFrom(env, db, request))!
      const days = Number(new URL(request.url).searchParams.get('days') ?? 30)

      /*
        Somebody is here, so the meter gets a chance to report.

        A node in a dispatch namespace has no timer, so the only moments
        available are the ones a request creates. Awaited rather than fired and
        forgotten, because a Worker cancels what is still in flight when the
        response goes out — the same thing that swallowed the fulfilment email.
        Throttled to once an hour, so this is almost always a single KV read.
      */
      await maybeReport(env, db)

      return Response.json(
        await insightsFor(db, principal, {
          days: Number.isFinite(days) ? days : 30,
        }),
        // Somebody's own numbers, and a shared cache has no business holding
        // them — two vendors asking the same URL must not get one answer.
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    },
  }),
)
