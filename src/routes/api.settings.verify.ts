import { eq } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { settings } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import type { DnsCheck } from '#/server/dns'
import { apiRequirement, checkRecord, frontendRequirement } from '#/server/dns'
import { currentConnection } from '#/server/github-store'
import { getSettings, publicApiBase } from '#/server/settings'
import { applyPagesDomain, registerApiHostname } from '#/server/domains'

/**
 * Checks the DNS for whichever domains are set, and applies the ones that pass.
 *
 * Verification and application are deliberately the same request: a domain that
 * resolves correctly but was never wired up is a worse state to be in than
 * either extreme, because the UI would say "verified" while nothing served it.
 */
export const Route = createFileRoute('/api/settings/verify')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      const current = await getSettings(db)
      const connection = await currentConnection(db)

      let host = ''
      try {
        host = new URL(env.PUBLIC_URL ?? '').hostname
      } catch {
        host = ''
      }

      const result: {
        api?: DnsCheck & { applied?: boolean; note?: string }
        frontend?: DnsCheck & { applied?: boolean; note?: string }
      } = {}

      let apiVerified = current.apiVerified
      let frontendVerified = current.frontendVerified

      if (current.apiDomain) {
        const check = await checkRecord(apiRequirement(current.apiDomain, host))
        apiVerified = check.ok

        let applied = false
        let note: string | undefined
        if (check.ok) {
          const registered = await registerApiHostname(
            env,
            current.apiDomain,
            env.NODE_ID,
          )
          applied = registered.ok
          note = registered.note
        }
        result.api = { ...check, applied, note }
      }

      if (current.frontendDomain) {
        if (!connection?.login || !connection.repoOwner || !connection.repoName) {
          result.frontend = {
            ok: false,
            type: 'CNAME',
            name: current.frontendDomain,
            expected: [],
            found: [],
            message: 'Connect GitHub and publish a site before pointing a domain at it.',
          }
        } else {
          const check = await checkRecord(
            frontendRequirement(current.frontendDomain, connection.login),
          )
          frontendVerified = check.ok

          let applied = false
          let note: string | undefined
          if (check.ok) {
            const result_ = await applyPagesDomain(
              connection.accessToken,
              connection.repoOwner,
              connection.repoName,
              current.frontendDomain,
            )
            applied = result_.ok
            note = result_.note
          }
          result.frontend = { ...check, applied, note }
        }
      }

      await db
        .update(settings)
        .set({ apiVerified, frontendVerified, updatedAt: new Date() })
        .where(eq(settings.id, current.id))

      const saved = await getSettings(db)

      return Response.json({
        ok: true,
        checks: result,
        apiBase: publicApiBase(env, saved),
        settings: {
          apiDomain: saved.apiDomain,
          apiVerified: saved.apiVerified,
          frontendDomain: saved.frontendDomain,
          frontendVerified: saved.frontendVerified,
        },
      })
    },
  }),
)
