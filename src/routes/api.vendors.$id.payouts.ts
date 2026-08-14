import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { payouts, vendorLedger, vendors } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { allows, can, forbidden, principalFrom } from '#/server/authz'
import { providerConfig } from '#/server/payments/orders'
import { createAccount, accountState, onboardingLink } from '#/server/payouts/connect'
import { standingFor, withdraw } from '#/server/payouts/withdraw'
import { record } from '#/server/events'

/**
 * A vendor's money: what they are owed, and taking it.
 *
 * One route for the whole relationship, because a vendor looking at this is
 * asking one question with three parts — how much, what will it cost, and can I
 * have it. Splitting those across three screens is how a fee stops feeling
 * transparent.
 *
 * Everything is narrowed by the same rule as everything else. A vendor reaches
 * their own; a rootAdmin reaches all of them.
 */

async function reachable(
  env: ReturnType<typeof getEnv>,
  db: ReturnType<typeof getDb>,
  request: Request,
  vendorId: number,
) {
  const principal = await principalFrom(env, db, request)
  if (!principal) return { ok: false as const, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!can(principal, 'vendors:read')) {
    return { ok: false as const, response: forbidden('vendors:read') }
  }
  if (!allows(principal, 'vendors:read', { id: vendorId, vendorId })) {
    return { ok: false as const, response: Response.json({ error: 'Not found' }, { status: 404 }) }
  }
  return { ok: true as const, principal }
}

export const Route = createFileRoute('/api/vendors/$id/payouts')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      if (!enabled.includes('vendors') || !enabled.includes('payments')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const vendorId = Number(params.id)
      const gate = await reachable(env, db, request, vendorId)
      if (!gate.ok) return gate.response

      // Refreshed from the provider rather than trusted from our own row:
      // whether an account may be paid is their answer, and it changes without
      // telling us.
      const [vendor] = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .limit(1)
      const found = await providerConfig(env, db)
      if (vendor?.stripeAccountId && found) {
        try {
          const state = await accountState(found.config, vendor.stripeAccountId)
          await db
            .update(vendors)
            .set({
              payoutsEnabled: state.payoutsEnabled,
              onboardingStatus: state.status,
            })
            .where(eq(vendors.id, vendorId))
        } catch {
          /* keep what we last knew */
        }
      }

      const standing = await standingFor(env, db, vendorId)
      const history = await db
        .select()
        .from(payouts)
        .where(eq(payouts.vendorId, vendorId))
        .orderBy(desc(payouts.id))
        .limit(20)
      const lines = await db
        .select()
        .from(vendorLedger)
        .where(eq(vendorLedger.vendorId, vendorId))
        .orderBy(desc(vendorLedger.id))
        .limit(50)

      return Response.json(
        {
          ...standing,
          payouts: history.map((row) => ({
            id: row.id,
            gross: row.gross,
            feeEstimate: row.feeEstimate,
            feeActual: row.feeActual,
            net: row.net,
            status: row.status,
            createdAt: row.createdAt,
          })),
          ledger: lines.map((row) => ({
            kind: row.kind,
            amount: row.amount,
            note: row.note,
            createdAt: row.createdAt,
          })),
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    },

    POST: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      if (!enabled.includes('vendors') || !enabled.includes('payments')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const vendorId = Number(params.id)
      const gate = await reachable(env, db, request, vendorId)
      if (!gate.ok) return gate.response
      // Reading what you are owed and taking it are different acts.
      if (!can(gate.principal, 'payouts:withdraw')) {
        return forbidden('payouts:withdraw')
      }

      const body = (await request.json().catch(() => ({}))) as { amount?: number }
      const result = await withdraw(env, db, vendorId, Number(body.amount ?? 0))
      return Response.json(result, { status: result.ok ? 200 : 422 })
    },

    /** Starts or resumes Stripe's own onboarding. */
    PUT: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      if (!enabled.includes('vendors') || !enabled.includes('payments')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const vendorId = Number(params.id)
      const gate = await reachable(env, db, request, vendorId)
      if (!gate.ok) return gate.response
      if (!can(gate.principal, 'payouts:withdraw')) {
        return forbidden('payouts:withdraw')
      }

      const found = await providerConfig(env, db)
      if (!found) {
        return Response.json(
          { error: 'This node is not taking payments yet.' },
          { status: 503 },
        )
      }

      const [vendor] = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .limit(1)
      if (!vendor) return Response.json({ error: 'Not found' }, { status: 404 })

      try {
        let accountId = vendor.stripeAccountId
        if (!accountId) {
          accountId = await createAccount(found.config, {
            email: vendor.email,
            name: vendor.name,
          })
          await db
            .update(vendors)
            .set({ stripeAccountId: accountId, onboardingStatus: 'pending' })
            .where(eq(vendors.id, vendorId))
          await record(db, {
            name: 'vendor.payouts_started',
            actor: gate.principal,
            vendorId,
            subjectType: 'vendors',
            subjectId: vendorId,
          })
        }

        const origin = new URL(request.url).origin
        const url = await onboardingLink(
          found.config,
          accountId,
          `${origin}/admin/vendors/${vendorId}`,
          `${origin}/admin/vendors/${vendorId}`,
        )
        return Response.json({ url })
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error ? error.message : 'Could not start that.',
          },
          { status: 502 },
        )
      }
    },
  }),
)
