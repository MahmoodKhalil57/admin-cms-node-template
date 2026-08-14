import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { can, principalForUserId } from '#/server/authz'
import { cmsTokenFrom, verifyCmsToken } from '#/server/cms-token'
import {
  ProxyError,
  forward,
  identity,
  loadCollections,
  mayTouch,
  refuse,
  resolveTarget,
  subjectFor,
} from '#/server/cms-proxy'

/**
 * GitHub's REST API, as this node's accounts may use it.
 *
 * The path is `/api/cms/api/v3/...` because Sveltia normalises whatever
 * `api_root` it is given: a URL already ending in `/api/v3` is left alone, and
 * anything else has a suffix appended and would land somewhere this route is
 * not. Ugly, and load-bearing.
 *
 * Reads are forwarded once the account holds `content:read`; the fine-grained
 * rule for reading is applied to the configuration instead, which is what
 * decides the collections that exist at all. Writes that arrive here are
 * refused outright — every commit Sveltia makes goes through GraphQL, so a
 * write on this endpoint is not the CMS asking.
 */
export const Route = createFileRoute('/api/cms/api/v3/$')(
  serverRoute(
    {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      PATCH: ({ request }) => handle(request),
      PUT: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
    },
    // Exempt from the profile gate: the CMS carries its own token and its own
    // refusals, and a JSON gate response is not one it can read.
    { gate: 'none' },
  ),
)

const PREFIX = '/api/cms/api/v3'

async function handle(request: Request): Promise<Response> {
  const env = getEnv(request)
  const db = getDb(env)

  const userId = await verifyCmsToken(env, cmsTokenFrom(request))
  if (!userId) return refuse(401, 'Bad credentials')

  const principal = await principalForUserId(env, db, userId)
  if (!principal) return refuse(401, 'Bad credentials')

  const url = new URL(request.url)
  const path = url.pathname.slice(PREFIX.length) || '/'

  // Answered rather than forwarded: the GitHub account behind this proxy is the
  // node's, and it is not who is editing.
  if (path === '/user') return identity(principal)

  const write = !['GET', 'HEAD'].includes(request.method)

  try {
    const target = await resolveTarget(db, path)

    /**
     * "Is this person allowed to edit here?" — asked of GitHub, answered here.
     *
     * Sveltia checks collaboration before it opens the editor, and forwarding
     * that would ask GitHub about an account GitHub has never heard of: these
     * editors have no GitHub identity at all, which is the point. So the
     * question is answered by the thing that actually knows, in GitHub's own
     * vocabulary — 204 for yes, 404 for no.
     */
    if (/^\/collaborators\/[^/]+$/.test(target.rest)) {
      return can(principal, 'content:read')
        ? new Response(null, { status: 204 })
        : refuse(404, 'Not a collaborator.')
    }

    if (write) {
      // Sveltia commits over GraphQL. Anything writing here is something else.
      return refuse(403, 'Writes go through the commit endpoint.')
    }

    const collections = await loadCollections(target)
    const subject = subjectFor(collections, contentPath(target.rest))
    if (!mayTouch(principal, subject, false)) {
      return refuse(403, 'Your account cannot read that.')
    }

    return forward(target, request, url.search)
  } catch (error) {
    if (error instanceof ProxyError) return refuse(error.status, error.message)
    return refuse(502, 'The repository could not be reached.')
  }
}

/** The repository path a `/contents/...` call is about, if it is about one. */
function contentPath(rest: string): string {
  const match = /^\/contents\/(.+)$/.exec(rest)
  return match ? decodeURIComponent(match[1]!) : ''
}
