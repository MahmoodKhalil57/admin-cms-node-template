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

          const changes = commitChanges(body)
          if (changes) {
            const denied = await audit(target, principal, changes)
            if (denied) return refuse(403, denied)
          } else if (!can(principal, 'content:read')) {
            return refuse(403, 'Your account cannot read this site.')
          }

          return forwardGraphql(target, body)
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

async function forwardGraphql(
  target: ProxyTarget,
  body: unknown,
): Promise<Response> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'admin-cms-node',
    },
    body: JSON.stringify(body),
  })

  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type':
        response.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'private, no-store',
    },
  })
}

async function repoPrefix(db: Parameters<typeof resolveTarget>[0]) {
  const { currentConnection } = await import('#/server/github-store')
  const connection = await currentConnection(db)
  return `/repos/${connection?.repoOwner}/${connection?.repoName}`
}
