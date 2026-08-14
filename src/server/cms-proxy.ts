import type { NodeDb } from '#/db'
import type { Principal } from './authz'
import { allows, can } from './authz'
import { currentConnection } from './github-store'
import { CONFIG_PATH, decode, gh } from './static-store'
import { parseSveltiaConfig } from './sveltia'
import type { StaticCollection } from './sveltia'

/**
 * The repository, seen through this node's permissions.
 *
 * Sveltia's GitHub backend is left exactly as it is. It asks for trees, blobs
 * and commits in GitHub's own dialect and gets GitHub's own answers — which is
 * the whole point of doing it this way. Nothing is translated into another
 * shape and back, so every widget, every preview and every commit message keeps
 * working, and a Sveltia release brings its improvements with it.
 *
 * What changes is who is on each end. In front, a browser holding a token that
 * says which of *this node's* accounts is asking. Behind, the node's own GitHub
 * credential, which never leaves the Worker. Between them, this: a check that
 * the account may do this, to this collection, to this field.
 *
 * Two containments, both here because both are cheap to state and expensive to
 * forget:
 *
 * 1. **One repository.** Every path is checked against the connected site
 *    before it is forwarded. The credential behind this proxy can reach other
 *    repositories; this proxy cannot be asked to.
 *
 * 2. **The collection, not the file.** A path means nothing on its own, so it
 *    is resolved against the repo's own Sveltia config first. `content/site.json`
 *    is not a path to be pattern-matched — it is the `settings` singleton, and
 *    that is what a policy gets to talk about.
 */

/** Endpoints Sveltia's GitHub backend actually uses, and nothing else. */
const REPO_PATHS = [
  /^$/,
  /^\/branches\/[^/]+$/,
  /^\/collaborators\/[^/]+$/,
  /^\/contents(\/.*)?$/,
  /^\/commits$/,
  /^\/git\/(blobs|trees|commits|refs)(\/.*)?$/,
  /^\/git\/matching-refs\/.*$/,
]

export interface ProxyTarget {
  owner: string
  repo: string
  token: string
  /** the rest of the GitHub path, after `/repos/{owner}/{repo}` */
  rest: string
}

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function refuse(status: number, message: string): Response {
  return Response.json({ message }, { status })
}

/**
 * Which repository path this request is for, if it is one this node owns.
 *
 * `/user` is answered here rather than forwarded — see `identity` below.
 */
export async function resolveTarget(
  db: NodeDb,
  path: string,
): Promise<ProxyTarget> {
  const connection = await currentConnection(db)
  if (!connection?.repoOwner || !connection.repoName) {
    throw new ProxyError(503, 'This node has no site connected yet.')
  }

  const prefix = `/repos/${connection.repoOwner}/${connection.repoName}`
  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    // Either a different repository or an endpoint outside the set Sveltia
    // needs. Both are refused the same way: this proxy speaks about one site.
    throw new ProxyError(404, 'Not found.')
  }

  const rest = path.slice(prefix.length)
  if (!REPO_PATHS.some((allowed) => allowed.test(rest))) {
    throw new ProxyError(404, 'Not found.')
  }

  return {
    owner: connection.repoOwner,
    repo: connection.repoName,
    token: connection.accessToken,
    rest,
  }
}

/**
 * Who Sveltia shows in the corner.
 *
 * Answered from this node's account rather than forwarded, because the GitHub
 * account behind the proxy is the node's and not the editor's. Showing it would
 * tell four designers they are all signed in as the same person, and tell them
 * an account name that is not theirs to use.
 */
export function identity(principal: Principal): Response {
  return Response.json({
    login: principal.email,
    name: principal.name ?? principal.email,
    // Sveltia reads these to decide what to show; none of them is a permission.
    id: 0,
    avatar_url: '',
    html_url: '',
  })
}

/**
 * The signed-in account, in the shape Sveltia keeps in local storage.
 *
 * Built here rather than in the page because this is where the same answer is
 * already given to `/user` — one place decides who the CMS thinks it is, and
 * the page does not have to know the shape to hand it over.
 *
 * The fields Sveltia does not use are still present and empty. It writes back
 * whatever it holds, and an object missing half its keys is one that looks
 * corrupted the next time something reads it.
 */
export function sveltiaAccount(
  principal: Principal,
  token: string,
): Record<string, unknown> {
  return {
    backendName: 'github',
    id: 0,
    name: principal.name ?? principal.email,
    login: principal.email,
    avatarURL: '',
    profileURL: '',
    bot: false,
    token,
  }
}

/* --- what a path is ------------------------------------------------------ */

export interface Subject {
  /** the collection this file belongs to, from the repo's own config */
  collection: string | null
  /** the file entry within a `files` collection, e.g. `site` */
  file: string | null
  /** the repository path itself, for a rule that has to name one */
  path: string
}

/**
 * The repo's Sveltia config, so paths can be spoken about as collections.
 *
 * Read from the same file the CMS reads, so the two never disagree about what a
 * collection is. Cached per request only — a config edited in the CMS has to
 * take effect on the next one.
 */
export async function loadCollections(
  target: ProxyTarget,
): Promise<Array<StaticCollection>> {
  const response = await gh(
    target,
    'GET',
    `/repos/${target.owner}/${target.repo}/contents/${CONFIG_PATH}`,
  )
  if (response.status !== 200 || !response.json?.content) return []
  try {
    return parseSveltiaConfig(decode(response.json.content))
  } catch {
    return []
  }
}

/** Which collection a repository path belongs to, if any. */
export function subjectFor(
  collections: Array<StaticCollection>,
  path: string,
): Subject {
  const clean = path.replace(/^\/+/, '')

  for (const collection of collections) {
    if (collection.kind === 'folder') {
      const folder = (collection.folder ?? '').replace(/^\/+|\/+$/g, '')
      if (folder && clean.startsWith(`${folder}/`)) {
        return {
          collection: collection.name,
          // The entry's own name, which is what a rule about one page names.
          file: clean.slice(folder.length + 1).replace(/\.[^.]+$/, ''),
          path: clean,
        }
      }
      continue
    }

    for (const entry of collection.files ?? []) {
      if ((entry.file ?? '').replace(/^\/+/, '') === clean) {
        return { collection: collection.name, file: entry.name, path: clean }
      }
    }
  }

  return { collection: null, file: null, path: clean }
}

/**
 * Whether this account may do this to this file.
 *
 * The record handed to the policy engine is the subject — collection, file,
 * path — so a rule reads the way a person would say it: *the designers may
 * write to pages and symbols, but not to settings*. Exactly the same evaluation
 * that narrows submissions to one form narrows the site to one collection;
 * there is no second permission system here, only a second kind of record.
 *
 * A path no collection claims is refused for writes and allowed for reads. The
 * CMS reads far more than the collections it edits — its own config, the media
 * folder, the tree — and refusing those would leave an editor that cannot open.
 * Writing somewhere no collection describes is a different matter: there is no
 * rule that could have been written about it, so there is nothing to have
 * granted.
 */
export function mayTouch(
  principal: Principal,
  subject: Subject,
  write: boolean,
): boolean {
  const permission = write ? 'content:write' : 'content:read'
  if (!can(principal, permission)) return false
  if (principal.isOwner) return true

  if (!subject.collection) return !write

  return allows(principal, permission, {
    collection: subject.collection,
    file: subject.file,
    path: subject.path,
  })
}

/**
 * Whether this account may change these particular fields.
 *
 * The last and finest of the three. A policy that names fields refuses a write
 * that changes one of them, whatever else it is allowed to change in the same
 * file — which is how "designers may edit the pages but not their access rules"
 * is said without splitting the file in two.
 *
 * Only changed fields are tested. Sveltia sends whole documents, so a write
 * that happens to include a restricted field it did not touch is an ordinary
 * save, not an attempt.
 */
export function refusedFields(
  principal: Principal,
  subject: Subject,
  before: unknown,
  after: unknown,
): Array<string> {
  if (principal.isOwner) return []

  return changedKeys(before, after).filter(
    (field) =>
      !allows(principal, 'content:write', {
        collection: subject.collection,
        file: subject.file,
        path: subject.path,
        field,
      }),
  )
}

/** Top-level keys whose value differs between two documents. */
export function changedKeys(before: unknown, after: unknown): Array<string> {
  const one = isRecord(before) ? before : {}
  const two = isRecord(after) ? after : {}
  const keys = new Set([...Object.keys(one), ...Object.keys(two)])

  return [...keys].filter(
    (key) => JSON.stringify(one[key]) !== JSON.stringify(two[key]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Passes a request through to GitHub under the node's own credential. */
export async function forward(
  target: ProxyTarget,
  request: Request,
  search: string,
): Promise<Response> {
  const url = `https://api.github.com/repos/${target.owner}/${target.repo}${target.rest}${search}`
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.text()

  const response = await fetch(url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: request.headers.get('accept') ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'admin-cms-node',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  })

  // Passed through as-is: Sveltia reads statuses and error bodies, and a
  // helpfully rewritten failure is a failure it cannot recognise.
  const headers = new Headers()
  for (const name of ['content-type', 'etag', 'link', 'x-ratelimit-remaining']) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Cache-Control', 'private, no-store')

  return new Response(response.body, { status: response.status, headers })
}
