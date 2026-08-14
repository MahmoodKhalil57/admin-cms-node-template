import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import type { RoleCondition } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { can, forbidden, principalFrom } from '#/server/authz'
import { findMember } from '#/server/team'
import { listKeys, mintKey, revokeKey } from '#/server/api-keys'

/**
 * The keys held by one account.
 *
 * Under the member rather than in a place of their own, because a key is not a
 * thing in its own right — it is a way for something to be that account. Asking
 * "what can this key do" should send you to the same page as "what can this
 * user do", and it does.
 */
export const Route = createFileRoute('/api/team/$id/keys')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('user-management')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:read')) return forbidden('team:read')

      const rows = await listKeys(db, params.id)
      // Never the hash. There is nothing here anyone needs it for.
      return Response.json(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          lastUsedAt: row.lastUsedAt,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          createdAt: row.createdAt,
        })),
      )
    },

    POST: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('user-management')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:manage')) return forbidden('team:manage')

      const member = await findMember(env, params.id)
      if (!member) return Response.json({ error: 'Not found' }, { status: 404 })

      const body = (await request.json()) as {
        name?: string
        expiresInDays?: number
        allowedOrigins?: Array<string>
        ratePerMinute?: number
        /**
         * The second gate, chosen by whoever is minting.
         *
         * Omitted, the key is narrowed only by the account it belongs to. Given,
         * it is narrowed by both — and only what passes both is reachable, so
         * this can take away and can never add.
         */
        scope?: {
          permissions?: Array<string> | null
          conditions?: Record<string, RoleCondition>
          policies?: Array<string>
        }
      }
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86400 * 1000)
        : null

      const minted = await mintKey(db, params.id, body.name ?? '', expiresAt, {
        allowedOrigins: body.allowedOrigins,
        ratePerMinute: body.ratePerMinute,
        scope: body.scope,
      })
      // The only time the secret exists outside the caller's hands.
      return Response.json(minted, { status: 201 })
    },

    DELETE: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'team:manage')) return forbidden('team:manage')

      const id = Number(new URL(request.url).searchParams.get('key'))
      if (!id) return Response.json({ error: 'Which key?' }, { status: 400 })

      // Revoked, not deleted: the row is the record that it once existed.
      await revokeKey(db, id)
      return Response.json({ ok: true, id })
    },
  }),
)
