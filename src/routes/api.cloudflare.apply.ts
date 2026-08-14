import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import type { AppliedRecord } from '#/server/cloudflare-api'
import {
  CloudflareApiError,
  applyRequirement,
  findZone,
} from '#/server/cloudflare-api'
import { usableCloudflareToken } from '#/server/cloudflare-store'
import { planDomain } from '#/server/domain-plan'
import { getEnv } from '#/server/env'
import { currentConnection } from '#/server/github-store'
import { getSettings } from '#/server/settings'
import { registerCustomHostname } from '#/server/domains'

/**
 * Writes every DNS record the custom domain needs, into the operator's own
 * Cloudflare zone.
 *
 * This is the whole point of connecting Cloudflare: five records typed by hand
 * is five chances to get one wrong. It only writes what the plan already asks
 * for, so the manual instructions and this produce the same result.
 *
 * It deliberately does not mark anything verified — the existing DNS check does
 * that, against public DNS. Writing a record and believing it landed are
 * different claims, and only the second one matters.
 */
export const Route = createFileRoute('/api/cloudflare/apply')(
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

      const token = await usableCloudflareToken(db, env)
      if (!token) {
        return Response.json(
          { error: 'Connect Cloudflare first, or reconnect it.' },
          { status: 400 },
        )
      }

      try {
        const zone = await findZone(token, current.customDomain)
        if (!zone) {
          return Response.json(
            {
              error: `The connected Cloudflare account has no active zone for ${current.customDomain}.`,
            },
            { status: 404 },
          )
        }

        const connection = await currentConnection(db)
        const purposes = planDomain({
          root: current.customDomain,
          githubOwner: connection?.login,
        })

        const written: Array<AppliedRecord> = []
        const skipped: Array<{ label: string; reason: string }> = []

        for (const purpose of purposes) {
          if (!purpose.requirement) {
            skipped.push({
              label: purpose.label,
              reason: purpose.blocked ?? 'Not available yet.',
            })
            continue
          }
          written.push(
            ...(await applyRequirement(token, zone, purpose.requirement)),
          )
        }

        /*
          The records alone do not make a node reachable.

          Only `/admin*` and `/api*` are handed to this node, by Worker routes
          on the zone, and nothing about writing a DNS record creates one. So
          pressing this used to leave a correct record, a working website, and a
          panel that could not be opened — which reads like a broken panel
          rather than a missing route.

          Master does that half: it needs an account-scoped token that must
          never reach a node. Asked for here so the button is the whole job
          rather than the first half of it.

          Never allowed to fail the records that were already written. They are
          correct and worth keeping; what the route could not do is reported
          beside them.
        */
        const routed = await registerCustomHostname(env, current.customDomain)

        return Response.json({
          ok: true,
          zone: zone.name,
          written,
          skipped,
          routed: { ok: routed.ok, note: routed.note },
        })
      } catch (error) {
        const message =
          error instanceof CloudflareApiError || error instanceof Error
            ? error.message
            : String(error)
        const status =
          error instanceof CloudflareApiError ? (error.status ?? 500) : 500
        return Response.json({ ok: false, error: message }, { status })
      }
    },
  }),
)
