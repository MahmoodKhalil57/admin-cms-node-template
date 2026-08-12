import { drizzle } from 'drizzle-orm/d1'

import type { NodeEnv } from '#/server/env'
import * as schema from './schema'

/**
 * Builds a Drizzle client over this node's own D1 database.
 *
 * Deliberately a factory, not a module-level `db`: the binding only exists once
 * a request is in flight, so a top-level client is `undefined` at isolate init
 * on Workers.
 */
export function getDb(env: NodeEnv) {
  return drizzle(env.DB, { schema })
}

export type NodeDb = ReturnType<typeof getDb>
