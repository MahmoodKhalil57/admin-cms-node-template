import { betterAuth } from 'better-auth'

import type { NodeEnv } from './env'

/**
 * This node's authentication.
 *
 * Every node owns its own users, in its own D1 — there is no shared identity
 * and no federation from master. What links the two is `masterUserId` on the
 * user row: master seeds the node's first operator and records which master
 * account it came from, so the two can be related later without either side
 * having to trust the other at request time.
 *
 * Sign-up is disabled. The only account that exists is the one provisioning
 * seeds; anything else has to be created deliberately.
 *
 * Built per-request rather than at module scope, because the D1 binding does
 * not exist until a request is in flight. The cache keeps it to one instance
 * per isolate.
 */
function createAuth(env: NodeEnv) {
  return betterAuth({
    // The raw D1 binding, not a Drizzle adapter: Better Auth's `getMigrations()`
    // only works with its built-in Kysely adapter, and that is what lets
    // provisioning create the auth tables in a brand-new database.
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    // baseURL is deliberately unset so Better Auth infers it from the request.
    // One built artifact serves every node, and each answers on its own
    // hostname, so a baked-in URL would be wrong for all but one of them.
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    user: {
      additionalFields: {
        masterUserId: { type: 'string', required: false, input: false },
        /**
         * The key of a role row, not a fixed enum. What roles exist is the
         * business's decision, so this column names one rather than defining
         * it. `input: false` because nobody sets their own.
         */
        role: { type: 'string', required: false, input: false },
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 },
    },
  })
}

export type NodeAuth = ReturnType<typeof createAuth>

const cache = new WeakMap<NodeEnv, NodeAuth>()

export function getAuth(env: NodeEnv): NodeAuth {
  const hit = cache.get(env)
  if (hit) return hit

  const auth = createAuth(env)
  cache.set(env, auth)
  return auth
}
