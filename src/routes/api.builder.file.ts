import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { errorResponse, repoRef } from '#/server/static-context'
import { listRepoDir, readRepoFile } from '#/server/builder-store'

/**
 * One file, or one directory of entry files, straight from the repository.
 *
 * The builder needs what is committed now rather than what was last deployed —
 * a page saved a minute ago is not on the published site yet.
 */
export const Route = createFileRoute('/api/builder/file')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      try {
        const url = new URL(request.url)
        const path = url.searchParams.get('path') ?? ''
        // Reads are scoped to the repository, so a traversal cannot climb out
        // of it — but it can still name something this node has no business
        // handing over, so refuse the shape outright.
        if (!path || path.includes('..')) {
          return Response.json({ error: 'Bad path.' }, { status: 400 })
        }

        const ref = await repoRef(getDb(env))
        if (url.searchParams.get('kind') === 'dir') {
          return Response.json({ entries: await listRepoDir(ref, path) })
        }
        const text = await readRepoFile(ref, path)
        if (text === null) {
          return Response.json({ error: `No ${path}.` }, { status: 404 })
        }
        return Response.json({ text })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }),
)
