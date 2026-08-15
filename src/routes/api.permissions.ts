import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { ensureFeatureRows, getEnabledFeatures } from '#/server/features'
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
      const principal = await principalFrom(env, db, request)

      if (!principal) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      /*
        A feature shipped after this node was provisioned has no row yet.

        Provisioning does seed them, but master calls the node's own hook the
        moment the script is uploaded, and dispatch lookups are eventually
        consistent — so that call can land on the build before the one carrying
        the new feature, and the row is quietly never written.

        Seeding here as well makes it self-healing: the panel asks this on every
        load, and a feature that missed its provision appears on the next one.
        Existing rows are never touched, so an operator's choice survives.
      */
      await ensureFeatureRows(db)
      const enabled = await getEnabledFeatures(db)
      if (enabled.includes('user-management')) await ensureBuiltinRoles(db)

      return Response.json({
        catalog: permissionsFor(enabled),
        mine: principal.permissions,
        isOwner: principal.isOwner,
        roleKey: principal.roleKey,
        /*
          Which features are on, for anybody signed in.

          The panel reads this to decide which screens exist at all, and it used
          to get it from `/api/features` — which needs `settings:read`. Anyone
          without that got a 403, an empty list, and therefore a panel with no
          screens in it: react-admin renders its "add a Resource" splash when
          none of its children survive. A collaborator saw the kit's welcome
          page and no way to do the one job they were invited for.

          Which features a node runs is not a secret worth keeping — what you
          may *do* with each is gated separately, and that gate has not moved.
        */
        features: enabled,
      })
    },
  }),
)
