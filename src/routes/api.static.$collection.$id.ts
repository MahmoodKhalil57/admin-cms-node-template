import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { collectionFor, errorResponse, repoRef } from '#/server/static-context'
import { deleteEntry, getEntry, saveEntry } from '#/server/static-store'

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
        // Saving commits; GitHub's push webhook applies it. Doing it inline as
        // well would give panel edits a path of their own, and a rule that only
        // holds for one editor is not a rule.
        return Response.json(await saveEntry(ref, collection, params.id, body))
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
