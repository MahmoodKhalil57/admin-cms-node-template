import { cf } from './cloudflare'
import type { Account } from './cloudflare'

/**
 * A project's static files.
 *
 * The half of an upload that is easy to forget, because forgetting it produces
 * a Worker that answers every request with a 200. The document comes back
 * fine; the stylesheet and the JavaScript it asks for fall through to the same
 * handler and come back as HTML with `content-type: text/html`, and the browser
 * shows a blank page. Nothing looks broken from the outside — the health check
 * passes, the API answers, and the panel is simply not there.
 *
 * Cloudflare stores assets content-addressed and keeps them across versions and
 * across scripts, so on an unchanged build it asks for nothing and this costs a
 * single round trip. That is what makes the hundredth project as cheap as the
 * second.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  return (
    (dot >= 0 ? CONTENT_TYPES[path.slice(dot).toLowerCase()] : undefined) ??
    'application/octet-stream'
  )
}

/** Cloudflare keys assets by the first 32 hex characters of a SHA-256. */
async function assetHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

interface UploadSession {
  jwt?: string
  /** the hashes Cloudflare does not already hold, in upload batches */
  buckets?: Array<Array<string>>
}

/**
 * Uploads a project's assets and returns the token the script upload needs.
 *
 * Three steps whose endpoints differ in a way that is easy to get wrong:
 *
 *  1. Register a manifest of `path -> {hash, size}` against the script. This is
 *     the *plain* script URL, not the dispatch-namespaced one master uses.
 *  2. Upload each missing bucket, base64, to the *account-level* assets
 *     endpoint — authenticated with the session JWT rather than the token that
 *     started the session.
 *  3. The last response carries the completion token, which goes into the
 *     script's metadata as `assets.jwt`.
 *
 * Returns null when the build has no assets, which is not an error.
 */
export async function uploadAssets(
  account: Account,
  scriptName: string,
  assets: Record<string, string>,
): Promise<string | null> {
  const paths = Object.keys(assets)
  if (paths.length === 0) return null

  const byHash = new Map<string, { path: string; base64: string }>()
  const manifest: Record<string, { hash: string; size: number }> = {}

  for (const path of paths) {
    const base64 = assets[path]!
    const bytes = base64ToBytes(base64)
    const hash = await assetHash(bytes)
    manifest[path] = { hash, size: bytes.length }
    byHash.set(hash, { path, base64 })
  }

  const session = await cf<UploadSession>(
    account,
    `/accounts/${account.accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    { method: 'POST', body: JSON.stringify({ manifest }) },
  )
  if (!session.ok) {
    throw new Error(
      session.errors?.[0]?.message ?? 'Cloudflare would not start an asset upload.',
    )
  }

  const buckets = session.result?.buckets ?? []
  // Nothing missing: Cloudflare already holds every byte from another script or
  // an earlier version, so the session token is the completion token.
  if (buckets.every((bucket) => bucket.length === 0)) {
    return session.result?.jwt ?? null
  }

  let completion = session.result?.jwt ?? null

  for (const bucket of buckets) {
    if (bucket.length === 0) continue

    const form = new FormData()
    for (const hash of bucket) {
      const asset = byHash.get(hash)
      if (!asset) continue
      form.set(
        hash,
        new File([asset.base64], hash, { type: contentTypeFor(asset.path) }),
      )
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/workers/assets/upload?base64=true`,
      {
        method: 'POST',
        // The session JWT, and no Content-Type — fetch has to set the
        // multipart boundary itself or Cloudflare reads the body as script.
        headers: { Authorization: `Bearer ${session.result?.jwt}` },
        body: form,
      },
    )

    const body = (await response.json().catch(() => ({}))) as {
      result?: { jwt?: string }
      errors?: Array<{ message?: string }>
    }
    if (!response.ok) {
      throw new Error(
        body.errors?.[0]?.message ?? 'Cloudflare refused an asset upload.',
      )
    }
    if (body.result?.jwt) completion = body.result.jwt
  }

  return completion
}
