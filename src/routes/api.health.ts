import { createFileRoute } from '@tanstack/react-router'

import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'

/**
 * Says which node answered.
 *
 * Public and deliberately tiny — it carries a node's own id and nothing else.
 * It exists so a custom domain can be verified by asking whether it actually
 * reaches this node, which is the real question. Checking the shape of a DNS
 * record only approximates it, and stops working entirely once the record is
 * proxied and resolves to the proxy instead of the target.
 */
export const Route = createFileRoute('/api/health')(
  serverRoute({
    GET: ({ request }) =>
      Response.json(
        { ok: true, node: getEnv(request).NODE_ID },
        { headers: { 'Access-Control-Allow-Origin': '*' } },
      ),
  }),
)
