import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { permissionsFor } from '#/lib/permission-catalog'
import { principalFrom } from '#/server/authz'
import { ensureBuiltinRoles } from '#/server/team'

/**
 * What can be granted here, and what the caller currently holds.
 *
 * The panel needs both: the catalog to draw a role editor, and the caller's own
 * grants to decide which screens to show at all.
 */
export const Route = createFileRoute('/api/permissions')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      const principal = await principalFrom(env, db, request)

      if (!principal) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (enabled.includes('user-management')) await ensureBuiltinRoles(db)

      return Response.json({
        catalog: permissionsFor(enabled),
        mine: principal.permissions,
        isOwner: principal.isOwner,
        roleKey: principal.roleKey,
      })
    },
  }),
)
