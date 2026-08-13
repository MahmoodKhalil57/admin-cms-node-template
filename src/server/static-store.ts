import type { StaticCollection } from './sveltia'
import { fieldsForFile, parseSveltiaConfig } from './sveltia'

/**
 * Reads and writes the site's content straight in its git repository.
 *
 * There is no database here on purpose. The site is a no-build static site
 * whose content *is* files in the repo, and its own CMS commits to those same
 * files — so a copy in a database would be a second source of truth that drifts
 * the moment either side is used. Editing here produces ordinary commits, which
 * is also what makes the change deployable and revertable.
 *
 * The GitHub token belongs to the connection the operator already made for
 * publishing, so nothing new is asked of them.
 */

export const CONFIG_PATH = 'static-admin/config.yml'

export class StaticError extends Error {
  status: number
  constructor(message: string, status = 500) {
    super(message)
    this.name = 'StaticError'
    this.status = status
  }
}

interface Gh {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
}

export interface RepoRef {
  token: string
  owner: string
  repo: string
}

export async function gh(
  ref: RepoRef,
  method: string,
  path: string,
  body?: unknown,
): Promise<Gh> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ref.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'admin-cms-node',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

export function decode(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ''))
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  )
}

function encode(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

async function readFile(
  ref: RepoRef,
  path: string,
): Promise<{ text: string; sha: string } | null> {
  const res = await gh(ref, 'GET', `/repos/${ref.owner}/${ref.repo}/contents/${path}`)
  if (res.status === 404) return null
  if (res.status !== 200) {
    throw new StaticError(`Could not read ${path}.`, res.status)
  }
  return { text: decode(String(res.json.content)), sha: String(res.json.sha) }
}

async function writeFile(
  ref: RepoRef,
  path: string,
  text: string,
  message: string,
  sha?: string,
): Promise<void> {
  const res = await gh(ref, 'PUT', `/repos/${ref.owner}/${ref.repo}/contents/${path}`, {
    message,
    content: encode(text),
    ...(sha ? { sha } : {}),
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new StaticError(
      res.json?.message ?? `Could not write ${path}.`,
      res.status,
    )
  }
}

/** The content model, read from the repo the site actually uses. */
export async function loadModel(ref: RepoRef): Promise<{
  collections: Array<StaticCollection>
  yaml: string
}> {
  const file = await readFile(ref, CONFIG_PATH)
  if (!file) {
    throw new StaticError(
      `${ref.owner}/${ref.repo} has no ${CONFIG_PATH}, so it carries no content model.`,
      404,
    )
  }
  return { collections: parseSveltiaConfig(file.text), yaml: file.text }
}

export interface StaticEntry {
  /** react-admin needs an `id`; for files it is the entry name, for folders the slug */
  id: string
  [key: string]: unknown
}

function pathFor(collection: StaticCollection, id: string): string {
  if (collection.kind === 'files') {
    const entry = collection.files?.find((file) => file.name === id)
    if (!entry) throw new StaticError(`Unknown entry "${id}".`, 404)
    return entry.file
  }
  return `${collection.folder}/${id}.${collection.extension}`
}

export async function listEntries(
  ref: RepoRef,
  collection: StaticCollection,
): Promise<Array<StaticEntry>> {
  if (collection.kind === 'files') {
    const entries: Array<StaticEntry> = []
    for (const file of collection.files ?? []) {
      const found = await readFile(ref, file.file)
      entries.push({
        id: file.name,
        _label: file.label,
        ...(found ? (JSON.parse(found.text) as Record<string, unknown>) : {}),
      })
    }
    return entries
  }

  const res = await gh(
    ref,
    'GET',
    `/repos/${ref.owner}/${ref.repo}/contents/${collection.folder}`,
  )
  if (res.status === 404) return []
  if (res.status !== 200) {
    throw new StaticError(`Could not list ${collection.folder}.`, res.status)
  }

  const files = (res.json as Array<{ name: string; type: string }>).filter(
    (file) => file.type === 'file' && file.name.endsWith(`.${collection.extension}`),
  )

  const entries: Array<StaticEntry> = []
  for (const file of files) {
    const id = file.name.replace(new RegExp(`\\.${collection.extension}$`), '')
    const found = await readFile(ref, `${collection.folder}/${file.name}`)
    entries.push({
      id,
      ...(found ? (JSON.parse(found.text) as Record<string, unknown>) : {}),
    })
  }
  return entries
}

export async function getEntry(
  ref: RepoRef,
  collection: StaticCollection,
  id: string,
): Promise<StaticEntry> {
  const found = await readFile(ref, pathFor(collection, id))
  if (!found) throw new StaticError(`"${id}" does not exist.`, 404)
  return { id, ...(JSON.parse(found.text) as Record<string, unknown>) }
}

/** Strips the keys the admin adds so they never reach the file. */
function payload(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key.startsWith('_')) continue
    out[key] = value
  }
  return out
}

export async function saveEntry(
  ref: RepoRef,
  collection: StaticCollection,
  id: string,
  data: Record<string, unknown>,
): Promise<StaticEntry> {
  const path = pathFor(collection, id)
  const existing = await readFile(ref, path)

  // Merge rather than replace: a `files` entry may hold keys this collection's
  // fields do not describe, and dropping them would quietly delete content.
  const merged = existing
    ? { ...(JSON.parse(existing.text) as Record<string, unknown>), ...payload(data) }
    : payload(data)

  await writeFile(
    ref,
    path,
    `${JSON.stringify(merged, null, 2)}\n`,
    `Update ${collection.label}: ${id}`,
    existing?.sha,
  )

  return { id, ...merged }
}

export async function createEntry(
  ref: RepoRef,
  collection: StaticCollection,
  data: Record<string, unknown>,
): Promise<StaticEntry> {
  if (!collection.canCreate) {
    throw new StaticError(`${collection.label} does not allow new entries.`, 400)
  }

  const slugSource = collection.slugField
    ? data[collection.slugField]
    : undefined
  const id = String(slugSource ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')

  if (!id) {
    throw new StaticError(
      `A value for "${collection.slugField ?? 'slug'}" is needed to name the file.`,
      400,
    )
  }

  const path = pathFor(collection, id)
  if (await readFile(ref, path)) {
    throw new StaticError(`"${id}" already exists.`, 409)
  }

  await writeFile(
    ref,
    path,
    `${JSON.stringify(payload(data), null, 2)}\n`,
    `Add ${collection.label}: ${id}`,
  )

  return { id, ...payload(data) }
}

export async function deleteEntry(
  ref: RepoRef,
  collection: StaticCollection,
  id: string,
): Promise<StaticEntry> {
  if (!collection.canDelete) {
    throw new StaticError(`${collection.label} entries cannot be deleted.`, 400)
  }

  const path = pathFor(collection, id)
  const existing = await readFile(ref, path)
  if (!existing) throw new StaticError(`"${id}" does not exist.`, 404)

  const res = await gh(ref, 'DELETE', `/repos/${ref.owner}/${ref.repo}/contents/${path}`, {
    message: `Remove ${collection.label}: ${id}`,
    sha: existing.sha,
  })
  if (res.status !== 200) {
    throw new StaticError(res.json?.message ?? `Could not delete ${path}.`, res.status)
  }

  return { id, ...(JSON.parse(existing.text) as Record<string, unknown>) }
}

export { fieldsForFile }
