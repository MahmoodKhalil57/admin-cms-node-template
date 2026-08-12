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
  /**
   * Shared hostname -> node map, read by the dispatch Worker.
   *
   * Every node binds the same namespace and writes only its own hostname keys,
   * because the dispatcher has no database and has to resolve custom domains on
   * the hot path.
   */
  ROUTING?: KVNamespace
  /** identity, set per node as plain_text vars */
  NODE_ID: string
  NODE_NAME: string
  /** signs this node's sessions; secret_text, unique per node */
  BETTER_AUTH_SECRET: string
  /** guards the provisioning endpoint; secret_text */
  PROVISION_TOKEN: string
  /** comma-separated origins allowed to post to the public form API; `*` by default */
  ALLOWED_ORIGINS?: string
  /** platform-wide GitHub OAuth app, supplied by master */
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** the template repo new sites are generated from, as `owner/repo` */
  GITHUB_TEMPLATE_REPO?: string
  /**
   * This node's own public address.
   *
   * Supplied by master, because the dispatch Worker strips the `/n/<slug>`
   * prefix before forwarding — the node cannot work its own URL out from an
   * incoming request.
   */
  PUBLIC_URL?: string
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

