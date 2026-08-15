import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { can, principalFrom } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import {
  grantVendorCredits,
  packagesForVendors,
  runVendorMeter,
  vendorBalances,
  vendorUsage,
} from '#/server/vendor-billing'

/**
 * What a vendor owes the operator, and what they can buy.
 *
 * The same page answers two people. A vendor sees their own balance because
 * `principal.vendorIds` is what they act for; the operator sees every vendor's,
 * because `vendors:manage` is the marketplace owner's permission. No branch
 * decides which — the list is narrowed by what the asker is, which is the same
 * thing that scopes every other list on this node.
 *
 * The meter is run on read, for the same reason the platform's is: a node has
 * no scheduler, and a figure nobody is looking at does not need to be fresh.
 */
export const Route = createFileRoute('/api/vendor-billing')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      if (!enabled.includes('vendors')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!principal) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const operator = can(principal, 'vendors:manage')
      if (!operator && principal.vendorIds.length === 0) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      // Counted from the event log, so this is cheap and always current.
      await runVendorMeter(db)

      const only = operator ? undefined : principal.vendorIds
      const balances = await vendorBalances(db, only)

      return Response.json(
        {
          operator,
          balances,
          packages: await packagesForVendors(db),
          periods:
            balances.length === 1
              ? await vendorUsage(db, balances[0]!.vendorId)
              : [],
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    },

    /** The operator granting credits by hand — a goodwill line, or a refund. */
    POST: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const principal = await principalFrom(env, db, request)
      if (!principal || !can(principal, 'vendors:manage')) {
        const said = 'Not allowed. This needs "vendors:manage".'
        return Response.json({ error: said, message: said }, { status: 403 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        vendorId?: number
        credits?: number
        note?: string
      }
      const credits = Math.trunc(Number(body.credits))
      if (!body.vendorId || !Number.isFinite(credits) || credits === 0) {
        return Response.json(
          { error: 'Which vendor, and how many credits?' },
          { status: 422 },
        )
      }

      await grantVendorCredits(db, {
        vendorId: Number(body.vendorId),
        kind: 'grant',
        credits,
        note: body.note ?? 'Granted by the operator',
      })
      return Response.json({ ok: true, credits })
    },
  }),
)
