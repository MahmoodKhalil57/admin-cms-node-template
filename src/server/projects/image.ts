import type { NodeEnv } from '../env'

/**
 * The built node artifact, fetched from somewhere public.
 *
 * This is the piece that makes the whole feature honest. A project built on an
 * operator's own account has to get its code from somewhere, and every obvious
 * source puts a credential of ours back in the middle: our private bucket needs
 * our API token, and proxying the download through master means master is doing
 * the work and paying for it.
 *
 * A public GitHub release needs no authentication and is unmetered for public
 * repositories — so a node fetches this with nothing, and it costs nothing
 * however many projects are created. That is the only arrangement where "layer
 * three costs us zero and uses none of our keys" is a fact rather than a claim.
 *
 * `releases/latest/download/...` always resolves to the newest release, so a
 * node does not have to be told a version to build a current project.
 */

const DEFAULT_IMAGE_URL =
  'https://github.com/MahmoodKhalil57/admincms-node-image/releases/latest/download/node-image.json'

export interface NodeImage {
  version: string
  mainModule: string
  modules: Array<{ path: string; source: string }>
  /** repo path -> base64 */
  assets: Record<string, string>
  migrations: Array<{ name: string; sql: string }>
  compatibilityDate: string
  compatibilityFlags: Array<string>
}

export function imageUrlFor(env: NodeEnv): string {
  return (
    (env as unknown as { NODE_IMAGE_URL?: string }).NODE_IMAGE_URL ??
    DEFAULT_IMAGE_URL
  )
}

/**
 * Fetches and checks it.
 *
 * The shape is verified rather than trusted. This is the one input to
 * provisioning that comes from outside both accounts involved, and a truncated
 * download that got as far as valid JSON would otherwise be uploaded as a
 * Worker that does not run — a failure on somebody else's infrastructure, with
 * a message about modules.
 */
export async function fetchImage(env: NodeEnv): Promise<NodeImage> {
  const url = imageUrlFor(env)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(
      `Could not fetch the node image (${response.status}). The release may be missing.`,
    )
  }

  const image = (await response.json().catch(() => null)) as NodeImage | null
  if (
    !image ||
    typeof image.version !== 'string' ||
    !Array.isArray(image.modules) ||
    image.modules.length === 0 ||
    !Array.isArray(image.migrations) ||
    image.migrations.length === 0 ||
    !image.modules.some((module) => module.path === image.mainModule)
  ) {
    throw new Error(
      'The node image is not in the expected shape. It may have been published incompletely.',
    )
  }

  return image
}

/** Cloudflare hashes assets to decide which bytes it already holds. */
export async function assetHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as ArrayBuffer,
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
}

export function contentTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return TYPES[extension] ?? 'application/octet-stream'
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
