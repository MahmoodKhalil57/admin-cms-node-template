import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { acceptInvitation } from '#/server/team'

/**
 * Accepting an invitation.
 *
 * Public by necessity — the person following the link has no account yet, which
 * is the whole point. The token stands in for the session: it was generated
 * here, it is single-use, and it expires, so the only accounts this can create
 * are ones somebody with `team:manage` asked for.
 */
export const Route = createFileRoute('/api/invitations/accept')(
  serverRoute(
    {
      POST: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('user-management')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const body = (await request.json()) as {
          token?: string
          password?: string
          name?: string
        }
        const result = await acceptInvitation(
          env,
          db,
          body.token ?? '',
          body.password ?? '',
          body.name,
        )
        // One status for every reason it can fail: a bad token, a used token and
        // an expired token must not be distinguishable from outside.
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: 400 })
        }
        return Response.json({ ok: true, email: result.email })
      },
    },
    // Exempt from the profile gate: accepting comes before there is a profile to complete
    { gate: 'none' },
  ),
)
