import type { NodeDb } from '#/db'
import { repoHooks } from '#/db/schema'
import type { RepoRef } from './static-store'
import { gh } from './static-store'

/**
 * The push webhook that keeps the site's declaration and this node's forms in
 * step no matter who edits the file.
 *
 * Saving in the panel is only one of the ways `admin-cms.json` changes: it is
 * also written by the visual builder, by a commit made on github.com, by a pull
 * request, by anything with push access. Applying the declaration only when the
 * panel happens to be the editor is not a rule, it is a habit. GitHub telling
 * us about every push is.
 *
 * A webhook rather than an Actions workflow on purpose. It fires in about a
 * second instead of a minute, costs no Actions minutes, puts nothing in the
 * repository, and — the part that matters — keeps the shared secret here. The
 * workflow route would have had to store a credential of ours inside the
 * operator's repo to call back with.
 */

const EVENT = 'push'
export const HOOK_PATH = '/api/webhooks/github'

interface GhHook {
  id: number
  config?: { url?: string }
}

/** A secret we generate, hand over once, and check every delivery against. */
function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class HookError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** the token predates the scope, so reconnecting is the fix */
    readonly needsReconnect = false,
  ) {
    super(message)
  }
}

/**
 * Register the webhook, or point the existing one back at us.
 *
 * Idempotent by URL: re-running finds the hook it made last time and updates it
 * rather than stacking duplicates, which matters because this runs on every
 * connect and every re-provision.
 */
export async function ensureRepoHook(
  db: NodeDb,
  ref: RepoRef,
  callbackUrl: string,
): Promise<{ hookId: number; created: boolean }> {
  const base = `/repos/${ref.owner}/${ref.repo}/hooks`

  const listed = await gh(ref, 'GET', base)
  if (listed.status === 404 || listed.status === 403) {
    throw new HookError(
      'This GitHub connection cannot manage webhooks. Reconnect GitHub to grant it.',
      403,
      true,
    )
  }
  if (listed.status !== 200) {
    throw new HookError('Could not read the repository hooks.', listed.status)
  }

  const existing = (listed.json as Array<GhHook>).find(
    (hook) => hook.config?.url === callbackUrl,
  )

  const secret = newSecret()
  const config = {
    url: callbackUrl,
    content_type: 'json',
    secret,
    insecure_ssl: '0',
  }

  // The secret is rotated on every run. It is only ever compared against what
  // GitHub sends, so replacing it costs nothing and means a leaked one expires
  // the next time anything touches the connection.
  const res = existing
    ? await gh(ref, 'PATCH', `${base}/${existing.id}`, {
        active: true,
        events: [EVENT],
        config,
      })
    : await gh(ref, 'POST', base, {
        name: 'web',
        active: true,
        events: [EVENT],
        config,
      })

  if (res.status !== 200 && res.status !== 201) {
    throw new HookError(
      res.json?.message ?? 'Could not register the webhook.',
      res.status,
      res.status === 403 || res.status === 404,
    )
  }

  const hookId = Number(res.json.id)
  await db.delete(repoHooks)
  await db.insert(repoHooks).values({ hookId, url: callbackUrl, secret })

  return { hookId, created: !existing }
}

export async function currentHook(db: NodeDb) {
  const [row] = await db.select().from(repoHooks).limit(1)
  return row ?? null
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant time, so a wrong signature cannot be narrowed down by timing. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Whether GitHub really sent this body.
 *
 * The endpoint has to be public — GitHub has no session — so the signature is
 * the only thing standing between it and anyone who knows the URL.
 */
export async function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  return sameString(`sha256=${toHex(signed)}`, header)
}

interface PushPayload {
  ref?: string
  repository?: { default_branch?: string }
  commits?: Array<{
    added?: Array<string>
    modified?: Array<string>
    removed?: Array<string>
  }>
}

/** Whether this push actually touched the file we care about. */
export function touches(payload: PushPayload, path: string): boolean {
  const branch = payload.repository?.default_branch ?? 'main'
  if (payload.ref && payload.ref !== `refs/heads/${branch}`) return false

  return (payload.commits ?? []).some((commit) =>
    [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])].includes(
      path,
    ),
  )
}
