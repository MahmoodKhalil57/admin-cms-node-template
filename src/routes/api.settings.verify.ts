import { eq } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { settings } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { checkRecord } from '#/server/dns'
import type { PurposeKey } from '#/server/domain-plan'
import { planDomain } from '#/server/domain-plan'
import { applyPagesDomain, registerApiHostname } from '#/server/domains'
import { currentConnection } from '#/server/github-store'
import { dispatcherHost, getSettings, publicApiBase } from '#/server/settings'

interface PurposeResult {
  key: PurposeKey
  label: string
  hostname: string
  ok: boolean
  found: Array<string>
  message: string
  applied: boolean
  note?: string
}

/**
 * Checks every record the custom domain needs, and wires up the ones that pass.
 *
 * Verification and application are the same request on purpose: a record that
 * resolves correctly but was never wired up is a worse state than either
 * extreme, because the screen would say "verified" while nothing served it.
 *
 * Each use is independent — the website can be live while the API's record is
 * still spreading — so one failing check never blocks the others.
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
      if (!current.customDomain) {
        return Response.json({ error: 'Set a domain first.' }, { status: 400 })
      }

      const connection = await currentConnection(db)
      const purposes = planDomain({
        root: current.customDomain,
        dispatcherHost: dispatcherHost(env),
        githubOwner: connection?.login,
      })

      const results: Array<PurposeResult> = []
      const verified: Record<string, boolean> = {
        frontend: current.frontendVerified,
        api: current.apiVerified,
      }

      for (const purpose of purposes) {
        if (!purpose.requirement) {
          results.push({
            key: purpose.key,
            label: purpose.label,
            hostname: purpose.hostname,
            ok: false,
            found: [],
            message: purpose.blocked ?? 'Not available yet.',
            applied: false,
          })
          continue
        }

        const check = await checkRecord(purpose.requirement)
        verified[purpose.key] = check.ok

        let applied = false
        let note: string | undefined

        if (check.ok) {
          if (purpose.key === 'frontend' && connection?.repoOwner && connection.repoName) {
            const outcome = await applyPagesDomain(
              connection.accessToken,
              connection.repoOwner,
              connection.repoName,
              purpose.hostname,
            )
            applied = outcome.ok
            note = outcome.note
          } else if (purpose.key === 'api') {
            const outcome = await registerApiHostname(
              env,
              purpose.hostname,
              env.NODE_ID,
            )
            applied = outcome.ok
            note = outcome.note
          }
        }

        results.push({
          key: purpose.key,
          label: purpose.label,
          hostname: purpose.hostname,
          ok: check.ok,
          found: check.found,
          message: check.message,
          applied,
          note,
        })
      }

      await db
        .update(settings)
        .set({
          frontendVerified: verified.frontend ?? false,
          apiVerified: verified.api ?? false,
          updatedAt: new Date(),
        })
        .where(eq(settings.id, current.id))

      const saved = await getSettings(db)

      return Response.json({
        ok: true,
        results,
        apiBase: publicApiBase(env, saved),
      })
    },
  }),
)
