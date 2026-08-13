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
  saveCustomDomain,
} from '#/server/settings'

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
