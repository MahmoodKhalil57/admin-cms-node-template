import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { repoRef } from '#/server/static-context'
import { readRepoFile } from '#/server/builder-store'
import { applyProjectToDb, PROJECT_PATH } from '#/server/forms-sync'
import type { ProjectFile } from '#/server/forms-sync'
import { currentHook, touches, verifySignature } from '#/server/repo-hook'

/**
 * GitHub telling us the site's declaration changed.
 *
 * This is the guarantee the panel alone could not give. `admin-cms.json` is
 * edited by the panel, by the visual builder, on github.com, by a pull request
 * — applying it only when the panel is the editor is a habit, not a rule. Every
 * push arrives here, so every edit lands on the node the same way.
 *
 * Public by necessity: GitHub has no session with us. The signature is what
 * stands in for one, so nothing is read or written before it checks out — and
 * an unsigned request is told nothing about why it failed.
 */
export const Route = createFileRoute('/api/webhooks/github')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)

      const hook = await currentHook(db)
      // The raw text, not the parsed object: the signature covers the bytes
      // GitHub sent, and re-serialising JSON would not reproduce them.
      const body = await request.text()

      if (
        !hook ||
        !(await verifySignature(
          hook.secret,
          body,
          request.headers.get('x-hub-signature-256'),
        ))
      ) {
        return Response.json({ error: 'Bad signature.' }, { status: 401 })
      }

      const event = request.headers.get('x-github-event')
      // GitHub pings a hook once when it is created, to prove it is reachable.
      if (event === 'ping') return Response.json({ ok: true, pong: true })
      if (event !== 'push') return Response.json({ ok: true, ignored: event })

      const payload = JSON.parse(body) as Parameters<typeof touches>[0]
      if (!touches(payload, PROJECT_PATH)) {
        return Response.json({ ok: true, ignored: 'untouched' })
      }

      try {
        const ref = await repoRef(db)
        const text = await readRepoFile(ref, PROJECT_PATH)
        if (text === null) {
          return Response.json({ ok: true, ignored: 'deleted' })
        }
        const applied = await applyProjectToDb(
          db,
          JSON.parse(text) as ProjectFile,
        )
        return Response.json({ ok: true, applied })
      } catch (error) {
        // Answering 500 asks GitHub to show the delivery as failed, which is
        // what the operator needs to see; it also leaves it redeliverable.
        const message = error instanceof Error ? error.message : String(error)
        return Response.json({ error: message }, { status: 500 })
      }
    },
  }),
)
