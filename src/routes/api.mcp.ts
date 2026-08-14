import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { principalFrom } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import { PROTOCOL_VERSION, RPC_CODES, handleRpc, rpcError } from '#/server/mcp'
import type { RpcRequest } from '#/server/mcp'

/**
 * The node, spoken to by an agent.
 *
 * One endpoint, no session, and the key in the `Authorization` header decides
 * everything — which is what makes this deployable anywhere an agent runs
 * without anything to set up on either side.
 *
 * The key is the same one minted for the REST API. Not a parallel credential
 * with parallel scopes: the same row, the same account behind it, the same two
 * gates. An agent given a key can reach exactly what a script given that key
 * could reach, and exactly what the person who minted it chose.
 */

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version',
    Vary: 'Origin',
  }
}

function unauthorised(request: Request): Response {
  return Response.json(
    { error: 'A valid API key is required.' },
    {
      status: 401,
      headers: {
        ...cors(request),
        // Points a client at how to get one, per the spec's use of the
        // standard challenge header.
        'WWW-Authenticate': 'Bearer realm="admin-cms-node"',
      },
    },
  )
}

export const Route = createFileRoute('/api/mcp')(
  serverRoute(
    {
      OPTIONS: ({ request }) =>
        new Response(null, { status: 204, headers: cors(request) }),

      /**
       * Answers what this endpoint is without needing a call.
       *
       * The Streamable HTTP transport allows a GET for a server-to-client
       * stream; this node has nothing to push, so it says so plainly rather
       * than holding a connection open that will never carry anything.
       */
      GET: ({ request }) =>
        Response.json(
          {
            name: 'admin-cms-node',
            protocolVersion: PROTOCOL_VERSION,
            transport: 'streamable-http',
            stateless: true,
            hint: 'POST JSON-RPC here with an Authorization: Bearer <api key> header.',
          },
          { headers: cors(request) },
        ),

      POST: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        const headers = cors(request)

        // Resolved the same way every other route resolves a key, so the two
        // gates are applied by the same code that applies them to REST.
        const principal = await principalFrom(env, db, request)
        if (!principal || !principal.viaKey) {
          // Deliberately keys only. A browser session reaching this would be a
          // way for a page to act as an agent without anybody minting anything.
          return unauthorised(request)
        }

        let message: RpcRequest | Array<RpcRequest>
        try {
          message = (await request.json()) as RpcRequest
        } catch {
          return Response.json(
            rpcError(null, RPC_CODES.parse, 'That is not JSON.'),
            { status: 400, headers },
          )
        }

        const features = await getEnabledFeatures(db)
        headers['MCP-Protocol-Version'] = PROTOCOL_VERSION

        // A batch is answered as a batch; notifications inside it drop out of
        // the reply, and a batch of only notifications is answered with 202.
        if (Array.isArray(message)) {
          const answers = (
            await Promise.all(
              message.map((one) => handleRpc(db, features, principal, one)),
            )
          ).filter((answer) => answer !== null)

          return answers.length
            ? Response.json(answers, { headers })
            : new Response(null, { status: 202, headers })
        }

        const answer = await handleRpc(db, features, principal, message)
        return answer === null
          ? new Response(null, { status: 202, headers })
          : Response.json(answer, { headers })
      },
    },
    // Exempt from the profile gate: a key is not a person, and there is nobody
    // behind an agent to answer a form asking for their name.
    { gate: 'none' },
  ),
)
