import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { can, forbidden, principalFrom } from '#/server/authz'
import { listMembers } from '#/server/team'

/**
 * Who has access to this node.
 *
 * A read of Better Auth's user table rather than a resource in the generic REST
 * layer, because Better Auth owns that table and a Drizzle mapping of it would
 * be a second opinion about a schema it migrates itself.
 */
export const Route = createFileRoute('/api/team/')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('user-management')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:read')) return forbidden('team:read')

      const members = await listMembers(env)
      return Response.json(members, {
        headers: {
          'Content-Range': `team 0-${Math.max(0, members.length - 1)}/${members.length}`,
          'Access-Control-Expose-Headers': 'Content-Range',
        },
      })
    },
  }),
)
