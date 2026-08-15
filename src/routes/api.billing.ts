import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { billingView, startCheckout } from '#/server/billing'
import { getSettings, panelOrigin } from '#/server/settings'

/**
 * What this node owes, and buying more.
 *
 * Behind `settings:read` and `settings:write` — a bill is the operator's
 * business rather than the team's, and starting a payment is a stronger act
 * than reading one.
 *
 * The return address is computed here rather than taken from the request. A
 * caller who could name it could send somebody back from a real payment to a
 * page of their choosing, which is a phishing flow with a genuine Stripe
 * receipt attached to it.
 */
export const Route = createFileRoute('/api/billing')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const denied = await requirePermission(env, db, request, 'settings:read')
      if (denied) return denied

      return Response.json(await billingView(env), {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    },

    POST: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const denied = await requirePermission(env, db, request, 'settings:write')
      if (denied) return denied

      const body = (await request.json().catch(() => ({}))) as {
        packageKey?: string
      }
      if (!body.packageKey) {
        return Response.json({ error: 'Which package?' }, { status: 422 })
      }

      const started = await startCheckout(
        env,
        String(body.packageKey),
        panelOrigin(env, await getSettings(db)),
      )
      if ('error' in started) {
        return Response.json(
          { error: started.error, message: started.error },
          { status: 502 },
        )
      }
      return Response.json(started)
    },
  }),
)
