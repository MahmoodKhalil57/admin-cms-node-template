import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { can, forbidden, principalFrom } from '#/server/authz'
import { findMember, removeMember, setMemberRole } from '#/server/team'

/**
 * One member: what they may do here, or whether they may at all.
 *
 * The owner is untouchable through this route. It is the account master seeded
 * and the one guaranteed way back into the node — a permission system that can
 * be used to lock out the only person holding the keys has failed at the one
 * thing it exists for.
 */
export const Route = createFileRoute('/api/team/$id')(
  serverRoute({
    PUT: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('user-management')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:manage')) return forbidden('team:manage')

      const member = await findMember(env, params.id)
      if (!member) return Response.json({ error: 'Not found' }, { status: 404 })
      if (member.isOwner) {
        return Response.json(
          { error: "The owner's access cannot be changed." },
          { status: 409 },
        )
      }

      const body = (await request.json()) as { roleKey?: string | null }
      await setMemberRole(env, params.id, body.roleKey ?? null)
      return Response.json({ ...member, roleKey: body.roleKey ?? null })
    },

    DELETE: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('user-management')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:manage')) return forbidden('team:manage')

      const member = await findMember(env, params.id)
      if (!member) return Response.json({ error: 'Not found' }, { status: 404 })
      if (member.isOwner) {
        return Response.json(
          { error: 'The owner cannot be removed.' },
          { status: 409 },
        )
      }
      // Removing yourself is not forbidden in principle, but doing it by
      // accident costs you the node, so it is refused here and left to another
      // administrator.
      if (member.id === principal?.userId) {
        return Response.json(
          { error: 'Ask another administrator to remove your own access.' },
          { status: 409 },
        )
      }

      await removeMember(env, params.id)
      return Response.json({ id: params.id })
    },
  }),
)
