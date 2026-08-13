import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { collectionFor, errorResponse, repoRef } from '#/server/static-context'
import { deleteEntry, getEntry, saveEntry } from '#/server/static-store'
import { applyProjectToDb } from '#/server/forms-sync'

export const Route = createFileRoute('/api/static/$collection/$id')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      try {
        const ref = await repoRef(getDb(env))
        const { collection } = await collectionFor(ref, params.collection)
        return Response.json(await getEntry(ref, collection, params.id))
      } catch (error) {
        return errorResponse(error)
      }
    },

    PUT: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      try {
        const ref = await repoRef(getDb(env))
        const { collection } = await collectionFor(ref, params.collection)
        const body = (await request.json()) as Record<string, unknown>
        const saved = await saveEntry(ref, collection, params.id, body)

        // The declaration is the point of this collection, so applying it is
        // part of saving it rather than a later step someone has to remember.
        if (collection.sync === 'forms') {
          const applied = await applyProjectToDb(getDb(env), saved)
          return Response.json({ ...saved, _sync: applied })
        }
        return Response.json(saved)
      } catch (error) {
        return errorResponse(error)
      }
    },

    DELETE: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      try {
        const ref = await repoRef(getDb(env))
        const { collection } = await collectionFor(ref, params.collection)
        return Response.json(await deleteEntry(ref, collection, params.id))
      } catch (error) {
        return errorResponse(error)
      }
    },
  }),
)
