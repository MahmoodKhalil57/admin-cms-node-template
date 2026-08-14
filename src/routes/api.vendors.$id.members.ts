import { createFileRoute } from '@tanstack/react-router'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { vendorMembers, vendors } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { allows, can, forbidden, principalFrom } from '#/server/authz'
import { listMembers } from '#/server/team'
import { record } from '#/server/events'

/**
 * Who acts for a vendor.
 *
 * Its own route rather than a column on the account, because it is a
 * relationship: a person can act for two businesses, and a business outlives
 * the person who set it up.
 *
 * Adding somebody is `vendors:manage` — deliberately not `vendors:write`. A
 * vendor may edit their own storefront; deciding who else can is the
 * marketplace owner's call, or a vendor could quietly hand their access to
 * anyone.
 */
export const Route = createFileRoute('/api/vendors/$id/members')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('vendors')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!principal) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (!can(principal, 'vendors:read')) return forbidden('vendors:read')

      const vendorId = Number(params.id)
      // Narrowed the same way a list is: a vendor asking about somebody else's
      // members is asking about a vendor they cannot see.
      if (!allows(principal, 'vendors:read', { id: vendorId, vendorId })) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const rows = await db
        .select()
        .from(vendorMembers)
        .where(eq(vendorMembers.vendorId, vendorId))

      // Joined against the accounts so the screen says who, not which id.
      const accounts = new Map(
        (await listMembers(env)).map((member) => [member.id, member]),
      )
      return Response.json(
        rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          email: accounts.get(row.userId)?.email ?? null,
          name: accounts.get(row.userId)?.name ?? null,
          createdAt: row.createdAt,
        })),
      )
    },

    POST: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('vendors')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'vendors:manage')) return forbidden('vendors:manage')

      const vendorId = Number(params.id)
      const [vendor] = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .limit(1)
      if (!vendor) return Response.json({ error: 'Not found' }, { status: 404 })

      const body = (await request.json()) as { userId?: string }
      const userId = String(body.userId ?? '')
      if (!userId) return Response.json({ error: 'Which account?' }, { status: 400 })

      const known = (await listMembers(env)).some((one) => one.id === userId)
      if (!known) {
        return Response.json({ error: 'No such account.' }, { status: 404 })
      }

      const [already] = await db
        .select()
        .from(vendorMembers)
        .where(
          and(
            eq(vendorMembers.vendorId, vendorId),
            eq(vendorMembers.userId, userId),
          ),
        )
        .limit(1)
      // Belonging twice is not a stronger belonging.
      if (already) return Response.json({ ok: true, id: already.id })

      const [row] = await db
        .insert(vendorMembers)
        .values({ vendorId, userId })
        .returning()

      await record(db, {
        name: 'vendor.member_added',
        actor: principal,
        vendorId,
        subjectType: 'vendors',
        subjectId: vendorId,
        detail: { userId },
      })

      return Response.json({ ok: true, id: row!.id }, { status: 201 })
    },

    DELETE: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('vendors')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'vendors:manage')) return forbidden('vendors:manage')

      const vendorId = Number(params.id)
      const userId = new URL(request.url).searchParams.get('user') ?? ''
      if (!userId) return Response.json({ error: 'Which account?' }, { status: 400 })

      await db
        .delete(vendorMembers)
        .where(
          and(
            eq(vendorMembers.vendorId, vendorId),
            eq(vendorMembers.userId, userId),
          ),
        )

      await record(db, {
        name: 'vendor.member_removed',
        actor: principal,
        vendorId,
        subjectType: 'vendors',
        subjectId: vendorId,
        detail: { userId },
      })

      return Response.json({ ok: true })
    },
  }),
)
