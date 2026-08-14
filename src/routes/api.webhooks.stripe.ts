import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { applyEvent, providerConfig } from '#/server/payments/orders'
import { providerFor } from '#/server/payments/stripe'

/**
 * Where Stripe tells this node what happened.
 *
 * The only thing that moves an order to paid. A buyer returning to the success
 * page proves they came back, which is not the same fact — they may have closed
 * the tab, and anybody may open that URL.
 *
 * Public by necessity and unauthenticated by design: the signature is the
 * authentication. Which is why the raw body is read as text and parsed
 * afterwards — the signature covers the exact bytes, and re-serialising the
 * JSON changes them.
 *
 * Always answers 200 once the signature checks out, even for an event this node
 * ignores or cannot place. A non-2xx tells Stripe to retry, and retrying will
 * not make an unknown event known; it only builds a queue that never drains.
 */
export const Route = createFileRoute('/api/webhooks/stripe')(
  serverRoute(
    {
      POST: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)

        if (!(await getEnabledFeatures(db)).includes('payments')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const found = await providerConfig(env, db)
        if (!found || found.key !== 'stripe') {
          return Response.json({ error: 'Not configured' }, { status: 404 })
        }

        const provider = providerFor('stripe')!
        const body = await request.text()
        const event = await provider.verify(
          found.config,
          body,
          request.headers.get('stripe-signature'),
        )

        // Unsigned, wrongly signed, or too old to be anything but a replay.
        // 400 rather than 401: there is no credential to supply.
        if (!event) {
          return Response.json({ error: 'Bad signature' }, { status: 400 })
        }

        const applied = await applyEvent(db, 'stripe', event, {
          env,
          origin: new URL(request.url).origin,
        })
        return Response.json({ received: true, ...applied })
      },
    },
    // Exempt from the profile gate: Stripe has no account here and no name to
    // give, and a JSON refusal would be retried for days.
    { gate: 'none' },
  ),
)
