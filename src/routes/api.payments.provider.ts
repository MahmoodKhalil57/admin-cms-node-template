import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { paymentProviders } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { can, forbidden, principalFrom } from '#/server/authz'
import { hint, open, seal } from '#/server/secrets'
import { PROVIDERS } from '#/server/payments/stripe'

/**
 * Setting up how this node takes money.
 *
 * rootAdmin brings their own account. The node never creates one, never sees a
 * card, and holds two secrets it seals before writing — see `secrets.ts`.
 *
 * What comes back out is never the key, only its last four characters. A screen
 * that can show a secret is a screen that leaks it, and there is no question a
 * reader has that the last four does not answer: *is the right key in there*.
 */
export const Route = createFileRoute('/api/payments/provider')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('payments')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'payments:configure')) {
        return forbidden('payments:configure')
      }

      const [row] = await db.select().from(paymentProviders).limit(1)
      const origin = new URL(request.url).origin

      return Response.json(
        {
          providers: Object.values(PROVIDERS).map((provider) => ({
            key: provider.key,
            label: provider.label,
            consoleUrl: provider.consoleUrl,
            /** paste this into their console; it is not a secret */
            webhookUrl: `${origin}/api/webhooks/${provider.key}`,
          })),
          current: row
            ? {
                key: row.key,
                publishableKey: row.publishableKey ?? '',
                secretKeyHint: hint(await open(env, row.secretKey)),
                webhookSecretHint: hint(await open(env, row.webhookSecret)),
                currency: row.currency,
                enabled: row.enabled,
              }
            : null,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    },

    PUT: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('payments')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      const principal = await principalFrom(env, db, request)
      if (!can(principal, 'payments:configure')) {
        return forbidden('payments:configure')
      }

      const body = (await request.json().catch(() => ({}))) as {
        key?: string
        publishableKey?: string
        secretKey?: string
        webhookSecret?: string
        currency?: string
        enabled?: boolean
      }

      const key = String(body.key ?? 'stripe')
      if (!PROVIDERS[key]) {
        return Response.json({ error: 'Unknown provider.' }, { status: 422 })
      }
      const currency = String(body.currency ?? 'USD').toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) {
        return Response.json(
          { error: 'Currency is a three-letter code, like USD.' },
          { status: 422 },
        )
      }

      const [existing] = await db.select().from(paymentProviders).limit(1)

      // An empty secret means "leave it alone", so saving the form after
      // changing the currency does not wipe the keys.
      const values = {
        key,
        publishableKey: body.publishableKey ?? existing?.publishableKey ?? null,
        secretKey: body.secretKey
          ? await seal(env, body.secretKey)
          : (existing?.secretKey ?? null),
        webhookSecret: body.webhookSecret
          ? await seal(env, body.webhookSecret)
          : (existing?.webhookSecret ?? null),
        currency,
        enabled: Boolean(body.enabled),
        updatedAt: new Date(),
      }

      if (existing) {
        await db
          .update(paymentProviders)
          .set(values)
          .where(eq(paymentProviders.id, existing.id))
      } else {
        await db.insert(paymentProviders).values(values)
      }

      return Response.json({ ok: true })
    },
  }),
)
