import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { can, forbidden, principalForUserId, principalFrom } from '#/server/authz'
import { KEY_FORBIDDEN } from '#/server/api-keys'

/**
 * What one account holds, so a key minted for it can be narrowed sensibly.
 *
 * The second gate can only ever take away, which makes the list of what the
 * account already has the only useful thing to offer. Showing the node's whole
 * catalogue instead would invite ticking something that cannot happen, and
 * leave whoever ticked it believing the key can do it.
 *
 * The permissions no key may carry are dropped here too, for the same reason:
 * they would be offered and then silently not granted.
 */
export const Route = createFileRoute('/api/team/$id/permissions')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)

      const asking = await principalFrom(env, db, request)
      if (!asking) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      // Reading what somebody else may do is a team question. Reading your own
      // is not — it is how you scope a key for yourself.
      if (asking.userId !== params.id && !can(asking, 'team:read')) {
        return forbidden('team:read')
      }

      const subject = await principalForUserId(env, db, params.id)
      if (!subject) return Response.json({ error: 'Not found' }, { status: 404 })

      return Response.json({
        permissions: subject.permissions.filter(
          (key) => !KEY_FORBIDDEN.includes(key),
        ),
      })
    },
  }),
)
