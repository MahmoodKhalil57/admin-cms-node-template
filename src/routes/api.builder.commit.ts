import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { errorResponse, repoRef } from '#/server/static-context'
import { commitFiles } from '#/server/builder-store'
import { record } from '#/server/events'
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
      const denied = await requirePermission(
        env,
        getDb(env),
        request,
        'content:write',
      )
      if (denied) return denied
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
        await record(getDb(env), {
          name: 'content.committed',
          subjectType: 'content',
          subjectId: sha,
          detail: { files: files.length, via: 'builder' },
        })
        return Response.json({ ok: true, commit: sha, files: files.length })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }),
)
