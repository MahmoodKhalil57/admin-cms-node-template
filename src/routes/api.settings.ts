import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { detectCloudflare } from '#/server/dns'
import { currentCloudflare } from '#/server/cloudflare-store'
import { planDomain } from '#/server/domain-plan'
import { currentConnection } from '#/server/github-store'
import {
  cleanDomain,
  getSettings,
  publicApiBase,
  rememberZone,
  saveCommission,
  saveCustomDomain,
} from '#/server/settings'
import { MAX_COMMISSION_BPS } from '#/server/store/commission'

export const Route = createFileRoute('/api/settings')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const denied = await requirePermission(
        env,
        getDb(env),
        request,
        'settings:read',
      )
      if (denied) return denied

      const db = getDb(env)
      const current = await getSettings(db)
      const connection = await currentConnection(db)

      // Only worth asking when there is a domain to ask about, and it decides
      // whether the operator is offered the automatic path at all.
      const cloudflare = current.customDomain
        ? await detectCloudflare(current.customDomain)
        : { onCloudflare: false, zone: null }

      if (cloudflare.zone !== current.dnsZone) {
        await rememberZone(db, cloudflare.zone)
      }

      const purposes = current.customDomain
        ? planDomain({
            root: current.customDomain,
            githubOwner: connection?.login,
          })
        : []

      const verified: Record<string, boolean> = {
        frontend: current.frontendVerified,
        api: current.apiVerified,
      }

      return Response.json({
        customDomain: current.customDomain,
        apiBase: publicApiBase(env, current),
        defaultApiBase: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
        pagesUrl: connection?.pagesUrl ?? null,
        githubOwner: connection?.login ?? null,
        onCloudflare: cloudflare.onCloudflare,
        cloudflareZone: cloudflare.zone,
        cloudflareConnected: Boolean(await currentCloudflare(db)),
        cloudflareConfigured: Boolean(
          env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET,
        ),
        commissionBps: current.commissionBps,
        purposes: purposes.map((purpose) => ({
          ...purpose,
          verified: verified[purpose.key] ?? false,
        })),
      })
    },

    PUT: async ({ request }) => {
      const env = getEnv(request)
      const denied = await requirePermission(
        env,
        getDb(env),
        request,
        'settings:write',
      )
      if (denied) return denied

      const body = (await request.json().catch(() => ({}))) as {
        customDomain?: string | null
        commissionBps?: number | string | null
      }

      /*
        The node's default cut, when that is what is being changed.

        Handled before the domain so a request that only carries a rate is not
        read as a request to clear the domain — `cleanDomain(undefined)` is
        null, and null is how the domain is removed.
      */
      if (body.commissionBps !== undefined) {
        const bps = Number(body.commissionBps)
        if (!Number.isInteger(bps) || bps < 0 || bps > MAX_COMMISSION_BPS) {
          return Response.json(
            {
              error: 'A commission is a whole number of basis points, from 0 to 10000.',
              message:
                'A commission is a whole number of basis points, from 0 to 10000.',
            },
            { status: 422 },
          )
        }
        await saveCommission(getDb(env), bps)
        if (body.customDomain === undefined) {
          return Response.json({ ok: true, commissionBps: bps })
        }
      }

      const cleaned = cleanDomain(body.customDomain)
      if (body.customDomain && !cleaned) {
        return Response.json(
          { error: `"${body.customDomain}" is not a valid domain name.` },
          { status: 400 },
        )
      }

      const updated = await saveCustomDomain(getDb(env), cleaned)
      return Response.json({ ok: true, customDomain: updated.customDomain })
    },
  }),
)
