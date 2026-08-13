import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { invitations, roles as rolesTable } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { can, forbidden, principalFrom } from '#/server/authz'
import { newInviteToken } from '#/server/team'
import { getSettings, panelOrigin } from '#/server/settings'

const VALID_FOR_DAYS = 7

/**
 * Invite someone, as a link.
 *
 * A link rather than an email because a node has no mail sender of its own yet,
 * and pretending otherwise would mean invitations that silently never arrive.
 * The link is handed back to whoever created it to pass on however they already
 * talk to that person.
 */
export const Route = createFileRoute('/api/invitations/create')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('user-management')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:manage')) return forbidden('team:manage')

      const body = (await request.json()) as { email?: string; roleKey?: string }
      const email = (body.email ?? '').trim().toLowerCase()
      const roleKey = (body.roleKey ?? '').trim()

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json(
          { error: 'That does not look like an email address.' },
          { status: 422 },
        )
      }

      const [role] = await db
        .select()
        .from(rolesTable)
        .where(eq(rolesTable.key, roleKey))
        .limit(1)
      if (!role) {
        return Response.json({ error: 'Pick a role first.' }, { status: 422 })
      }

      const token = newInviteToken()
      const expiresAt = new Date(Date.now() + VALID_FOR_DAYS * 86400 * 1000)

      const [created] = await db
        .insert(invitations)
        .values({
          email,
          roleKey,
          token,
          invitedBy: principal?.email ?? null,
          expiresAt,
        })
        .returning()

      const base = panelOrigin(env, await getSettings(db))
      return Response.json({
        ...created,
        url: `${base}/admin/join?token=${token}`,
      })
    },
  }),
)
