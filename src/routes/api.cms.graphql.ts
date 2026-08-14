import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { principalForUserId } from '#/server/authz'
import { can } from '#/server/authz'
import type { Principal } from '#/server/authz'
import { cmsTokenFrom, verifyCmsToken } from '#/server/cms-token'
import {
  ProxyError,
  loadCollections,
  mayTouch,
  refuse,
  refusedFields,
  resolveTarget,
  subjectFor,
} from '#/server/cms-proxy'
import type { ProxyTarget, Subject } from '#/server/cms-proxy'
import { decode, gh } from '#/server/static-store'
import { getEnabledFeatures } from '#/server/features'
import {
  applyVirtualDelete,
  applyVirtualWrite,
  isVirtual,
  virtualEntries,
} from '#/server/cms-virtual'
import type { VirtualEntry } from '#/server/cms-virtual'

/**
 * Where every change to the site is decided.
 *
 * Sveltia commits through one GraphQL mutation — `createCommitOnBranch` — and
 * that turns out to be the best thing about proxying it. One request carries
 * every path being written, every path being deleted, and the full new contents
 * of each. There is no sequence of blobs and trees to follow and no state to
 * keep between calls: the whole change is here, and it is either allowed or it
 * is not.
 *
 * So the three levels of the rule are all applied in one place:
 *
 * - **Collection.** Which of the repo's collections this file belongs to,
 *   resolved from the repo's own config rather than guessed from the path.
 * - **Entry.** Which singleton, or which page, within that collection.
 * - **Field.** Which keys actually changed, compared against what is committed
 *   now — so a policy can let a designer edit a page without letting them
 *   change what the page is allowed to do.
 *
 * A mutation that touches anything refused is refused whole. Committing the
 * allowed half of somebody's edit would leave the site in a state nobody chose.
 */

export const Route = createFileRoute('/api/cms/graphql')(
  serverRoute(
    {
      POST: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)

        const userId = await verifyCmsToken(env, cmsTokenFrom(request))
        if (!userId) return refuse(401, 'Bad credentials')

        const principal = await principalForUserId(env, db, userId)
        if (!principal) return refuse(401, 'Bad credentials')

        const body = (await request.json().catch(() => null)) as {
          query?: string
          variables?: Record<string, unknown>
        } | null
        if (!body?.query) return refuse(400, 'Malformed query.')

        try {
          const target = await resolveTarget(
            db,
            await repoPrefix(db),
          )

          const enabled = await getEnabledFeatures(db)
          const entries = await virtualEntries(db, env, principal, enabled)

          const changes = commitChanges(body)
          if (changes) {
            // Paths the node answers for are never sent to GitHub. They are
            // applied here, and the CMS is told the commit happened.
            const mine = {
              additions: changes.additions.filter((one) => isVirtual(one.path)),
              deletions: changes.deletions.filter((one) => isVirtual(one.path)),
            }
            const theirs = {
              additions: changes.additions.filter((one) => !isVirtual(one.path)),
              deletions: changes.deletions.filter((one) => !isVirtual(one.path)),
            }

            if (theirs.additions.length || theirs.deletions.length) {
              const denied = await audit(target, principal, theirs)
              if (denied) return refuse(403, denied)
            }

            if (mine.additions.length || mine.deletions.length) {
              const denied = await applyVirtual(db, env, principal, enabled, mine)
              if (denied) return refuse(403, denied)
              // Nothing left for GitHub: answer as a commit, so the editor
              // settles the way it does after any other save.
              if (!theirs.additions.length && !theirs.deletions.length) {
                return synthesisedCommit(body)
              }
            }
          } else if (!can(principal, 'content:read')) {
            return refuse(403, 'Your account cannot read this site.')
          }

          return forwardGraphql(target, body, entries)
        } catch (error) {
          if (error instanceof ProxyError) {
            return refuse(error.status, error.message)
          }
          return refuse(502, 'The repository could not be reached.')
        }
      },
    },
    // Exempt from the profile gate: the CMS carries its own token and reads
    // GraphQL errors, not gate responses.
    { gate: 'none' },
  ),
)

interface Changes {
  additions: Array<{ path: string; contents: string }>
  deletions: Array<{ path: string }>
}

/** The file changes a commit mutation is asking for, if this is one. */
function commitChanges(body: {
  query?: string
  variables?: Record<string, unknown>
}): Changes | null {
  if (!body.query?.includes('createCommitOnBranch')) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input = (body.variables as any)?.input
  const additions = Array.isArray(input?.fileChanges?.additions)
    ? input.fileChanges.additions
    : []
  const deletions = Array.isArray(input?.fileChanges?.deletions)
    ? input.fileChanges.deletions
    : []

  return {
    additions: additions.map((entry: { path?: string; contents?: string }) => ({
      path: String(entry.path ?? ''),
      contents: String(entry.contents ?? ''),
    })),
    deletions: deletions.map((entry: { path?: string }) => ({
      path: String(entry.path ?? ''),
    })),
  }
}

/**
 * Checks a whole commit, and says what stopped it.
 *
 * The message names the file rather than the permission, because the person
 * reading it is a designer looking at an editor, not an administrator looking
 * at a policy.
 */
async function audit(
  target: ProxyTarget,
  principal: Principal,
  changes: Changes,
): Promise<string | null> {
  if (!can(principal, 'content:write')) {
    return 'Your account cannot change this site.'
  }
  if (principal.isOwner) return null

  const collections = await loadCollections(target)

  for (const deletion of changes.deletions) {
    const subject = subjectFor(collections, deletion.path)
    if (!mayTouch(principal, subject, true)) {
      return `Your account cannot delete ${deletion.path}.`
    }
  }

  for (const addition of changes.additions) {
    const subject = subjectFor(collections, addition.path)
    if (!mayTouch(principal, subject, true)) {
      return `Your account cannot change ${addition.path}.`
    }

    const denied = await auditFields(target, principal, subject, addition)
    if (denied) return denied
  }

  return null
}

/**
 * The field level, which costs a read and is skipped when it cannot apply.
 *
 * Only JSON entries are compared: a rule about fields is a rule about a
 * document with named parts, and an image or a Markdown body has none to name.
 */
async function auditFields(
  target: ProxyTarget,
  principal: Principal,
  subject: Subject,
  addition: { path: string; contents: string },
): Promise<string | null> {
  if (!subject.collection || !addition.path.endsWith('.json')) return null

  let after: unknown
  try {
    after = JSON.parse(decode(addition.contents))
  } catch {
    // Not a document with fields, so there is nothing at this level to check.
    return null
  }

  const current = await gh(
    target,
    'GET',
    `/repos/${target.owner}/${target.repo}/contents/${encodeURI(addition.path)}`,
  )
  let before: unknown = {}
  if (current.status === 200 && current.json?.content) {
    try {
      before = JSON.parse(decode(current.json.content))
    } catch {
      before = {}
    }
  }

  const denied = refusedFields(principal, subject, before, after)
  if (!denied.length) return null

  return `Your account cannot change ${denied.join(', ')} in ${addition.path}.`
}

/** Applies the half of a commit that belongs to the database. */
async function applyVirtual(
  db: Parameters<typeof applyVirtualWrite>[0],
  env: Parameters<typeof applyVirtualWrite>[1],
  principal: Principal,
  enabled: Array<string>,
  changes: Changes,
): Promise<string | null> {
  for (const deletion of changes.deletions) {
    const denied = await applyVirtualDelete(
      db,
      env,
      principal,
      enabled,
      deletion.path,
    )
    if (denied) return denied
  }

  for (const addition of changes.additions) {
    let document: unknown
    try {
      document = JSON.parse(decode(addition.contents))
    } catch {
      return `${addition.path} is not a document this node can read.`
    }
    const denied = await applyVirtualWrite(
      db,
      env,
      principal,
      enabled,
      addition.path,
      document,
    )
    if (denied) return denied
  }

  return null
}

/**
 * A commit that did not happen, described as though it had.
 *
 * Sveltia asks for the new object ids so it can keep its own cache in step, and
 * these are answered from the paths — the same derivation the listing used, so
 * what it caches is what the next listing will say.
 */
function synthesisedCommit(body: { query?: string }): Response {
  const commit: Record<string, unknown> = {
    oid: '0'.repeat(40),
    committedDate: new Date().toISOString(),
  }
  // The mutation asks for `file_N: file(path: "...") { oid }` per addition.
  for (const [, index] of [
    ...(body.query ?? '').matchAll(/file_(\d+): file\(/g),
  ].map((match) => [match[0], match[1]] as const)) {
    commit[`file_${index}`] = { oid: '0'.repeat(40) }
  }

  return Response.json(
    { data: { createCommitOnBranch: { commit } } },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

/**
 * Forwards a query, answering the parts about files this node holds.
 *
 * Contents are asked for by object id, one alias per file, so a single query
 * usually mixes the repository's files with the node's. The node's aliases are
 * cut out before it is sent on and put back into the answer — GitHub is never
 * asked about an id it has never heard of, and Sveltia gets one response with
 * everything it asked for in it.
 */
async function forwardGraphql(
  target: ProxyTarget,
  body: { query?: string; variables?: Record<string, unknown> },
  entries: Array<VirtualEntry>,
): Promise<Response> {
  const byOid = new Map(entries.map((entry) => [entry.oid, entry]))
  const mine = new Map<string, VirtualEntry>()
  let query = body.query ?? ''

  if (byOid.size && query.includes('object(oid:')) {
    query = query.replace(
      /(\w+): object\(oid: "([0-9a-f]+)"\) \{[^}]*\{[^}]*\}[^}]*\}/g,
      (whole, alias: string, oid: string) => {
        const entry = byOid.get(oid)
        if (!entry) return whole
        mine.set(alias, entry)
        return ''
      },
    )
  }

  // Every alias was the node's, so there is nothing left to ask GitHub.
  if (mine.size && !/\w+: (object|ref)\(/.test(query)) {
    return Response.json(
      { data: { repository: answersFor(mine) } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'admin-cms-node',
    },
    body: JSON.stringify({ ...body, query }),
  })

  if (!mine.size) {
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'private, no-store',
      },
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const answer = (await response.json().catch(() => ({}))) as any
  if (answer?.data?.repository) {
    Object.assign(answer.data.repository, answersFor(mine))
  }
  return Response.json(answer, {
    status: response.status,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

/** The node's own aliases, in the shape the query asked for them. */
function answersFor(
  mine: Map<string, VirtualEntry>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [alias, entry] of mine) {
    out[alias] = { text: entry.text }
    // The matching `commit_N` alias, so the editor can say when it changed.
    const commitAlias = alias.replace(/^content_/, 'commit_')
    if (commitAlias !== alias) {
      out[commitAlias] = {
        target: {
          history: {
            nodes: [
              {
                author: { name: 'This node', email: '', user: null },
                committedDate: (entry.updatedAt ?? new Date()).toISOString(),
              },
            ],
          },
        },
      }
    }
  }
  return out
}

async function repoPrefix(db: Parameters<typeof resolveTarget>[0]) {
  const { currentConnection } = await import('#/server/github-store')
  const connection = await currentConnection(db)
  return `/repos/${connection?.repoOwner}/${connection?.repoName}`
}
