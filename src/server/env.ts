import type {
  D1Database,
  ExecutionContext,
  KVNamespace,
  R2Bucket,
} from '@cloudflare/workers-types'

/**
 * Everything this node is handed at provision time.
 *
 * Bindings come from the Workers-for-Platforms upload metadata, not from
 * `wrangler.jsonc` — that file only configures local dev. One built artifact
 * serves every node; nothing here is baked in at build time.
 */
export interface NodeEnv {
  DB: D1Database
  MEDIA: R2Bucket
  KV: KVNamespace
  /** identity, set per node as plain_text vars */
  NODE_ID: string
  NODE_NAME: string
  /** comma-separated feature keys master has enabled for this node */
  FEATURES: string
  /** guards the provisioning endpoints; secret_text, rotated after first use */
  PROVISION_TOKEN: string
}

type CloudflareRequest = Request & {
  runtime?: { cloudflare?: { env: NodeEnv; context: ExecutionContext } }
}

/**
 * Reads the Cloudflare bindings for the current request.
 *
 * Nitro's Cloudflare handler sets both `globalThis.__env__` and
 * `request.runtime.cloudflare` on every fetch. Neither exists at module scope,
 * which is why this is a function and why nothing in `src/server` may build a
 * database client at import time — that works in `vite dev` and throws on the
 * first production request.
 */
export function getEnv(request?: Request): NodeEnv {
  const fromRequest = (request as CloudflareRequest | undefined)?.runtime
    ?.cloudflare?.env
  if (fromRequest?.DB) return fromRequest

  const fromGlobal = (globalThis as { __env__?: NodeEnv }).__env__
  if (fromGlobal?.DB) return fromGlobal

  throw new Error(
    'Cloudflare bindings unavailable — getEnv() was called outside a request.',
  )
}

/** The execution context, for `waitUntil()`. */
export function getExecutionContext(
  request?: Request,
): ExecutionContext | undefined {
  return (request as CloudflareRequest | undefined)?.runtime?.cloudflare
    ?.context
}

/** Feature keys master has enabled for this node. */
export function enabledFeatures(env: NodeEnv): Array<string> {
  return (env.FEATURES ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
}
