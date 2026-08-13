import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { errorResponse, repoRef } from '#/server/static-context'
import { commitFiles } from '#/server/builder-store'
import type { CommitFile } from '#/server/builder-store'

/**
 * A builder save: many files, one commit.
 *
 * Writing them one at a time would leave the site broken between requests —
 * baked HTML referring to a stylesheet that has not landed, a manifest naming
 * a page whose drawing is not there yet.
 */
export const Route = createFileRoute('/api/builder/commit')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      try {
        const body = (await request.json()) as {
          message?: string
          files?: Array<CommitFile>
        }
        const files = (body.files ?? []).filter(
          (file) =>
            file &&
            typeof file.path === 'string' &&
            typeof file.content === 'string' &&
            !file.path.includes('..'),
        )
        if (!files.length) {
          return Response.json({ error: 'Nothing to commit.' }, { status: 400 })
        }

        const ref = await repoRef(getDb(env))
        const sha = await commitFiles(
          ref,
          files,
          body.message?.trim() || 'Update the page',
        )
        return Response.json({ ok: true, commit: sha, files: files.length })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }),
)
