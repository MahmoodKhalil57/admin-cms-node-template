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
import {
  applyPagesDomain,
  registerApiHostname,
  registerCustomHostname,
} from '#/server/domains'
import { currentConnection } from '#/server/github-store'
import { getSettings, publicApiBase } from '#/server/settings'

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

      // The browser's own result, when it sent one.
      //
      // Nothing server-side can answer this: Cloudflare bypasses a Worker route
      // for subrequests coming from its own Workers, so both this node and the
      // platform get the origin's 404 instead of the node's reply. The operator's
      // browser is outside that, and is exactly the client that matters.
      //
      // A client could of course lie. The only thing it buys is pointing their
      // own site at an address that does not work, so it is not worth defending
      // against — but the node id still has to match, so a stray success from
      // some other host is rejected.
      const submitted = (await request.json().catch(() => ({}))) as {
        apiProbe?: { ok?: boolean; node?: string }
      }

      const db = getDb(env)
      const current = await getSettings(db)
      if (!current.customDomain) {
        return Response.json({ error: 'Set a domain first.' }, { status: 400 })
      }

      const connection = await currentConnection(db)
      const purposes = planDomain({
        root: current.customDomain,
        githubOwner: connection?.login,
      })

      // One probe from master covers both purposes: it is the only vantage
      // point that sees what the public actually gets.
      const registration = await registerCustomHostname(env, current.customDomain)
      const probe = registration.probe

      const results: Array<PurposeResult> = []
      const verified: Record<string, boolean> = {
        frontend: current.frontendVerified,
        api: current.apiVerified,
      }

      for (const purpose of purposes) {
        if (!purpose.requirement && purpose.key !== 'api') {
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

        let applied = false
        let note: string | undefined
        let check: { ok: boolean; message: string; found: Array<string> }

        if (purpose.key === 'api') {
          const routed = await registerApiHostname(
            env,
            purpose.hostname,
            env.NODE_ID,
          )
          applied = routed.ok
          note = [routed.note, registration.note].filter(Boolean).join(' ')

          const fromBrowser =
            submitted.apiProbe?.ok === true &&
            submitted.apiProbe.node === env.NODE_ID

          check = {
            ok: fromBrowser,
            message: fromBrowser
              ? `Answering at https://${current.customDomain}/api`
              : submitted.apiProbe
                ? `https://${current.customDomain}/api did not answer as this node.`
                : 'Checking from your browser…',
            found: [],
          }
        } else if (purpose.key === 'frontend') {
          // Set the domain first, then look. The other order deadlocks: GitHub
          // will not serve a domain it has not been told about, so the check
          // would fail forever and the step that fixes it would never run.
          if (connection?.repoOwner && connection.repoName) {
            const outcome = await applyPagesDomain(
              connection.accessToken,
              connection.repoOwner,
              connection.repoName,
              purpose.hostname,
            )
            applied = outcome.ok
            note = outcome.note
          }

          // Judged by what it serves — once the record is proxied its CNAME is
          // no longer public, so inspecting DNS proves nothing.
          const live = probe ? probe.site === 200 : false
          check = {
            ok: live,
            message: live
              ? 'Serving your site.'
              : `https://${current.customDomain}/ answered ${probe?.site ?? 'nothing'} — GitHub can take a minute to rebuild after the domain is set.`,
            found: [],
          }
        } else {
          check = await checkRecord(purpose.requirement!)

          // Only the website purpose owns the Pages custom domain. Keying this
          // on "not the api purpose" set it to the API hostname the moment a
          // third purpose existed, and took the website offline.
          if (
            purpose.key === 'frontend' &&
            check.ok &&
            connection?.repoOwner &&
            connection.repoName
          ) {
            const outcome = await applyPagesDomain(
              connection.accessToken,
              connection.repoOwner,
              connection.repoName,
              purpose.hostname,
            )
            applied = outcome.ok
            note = outcome.note
          }
        }

        verified[purpose.key] = check.ok

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
