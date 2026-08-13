import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { collectionFor, errorResponse, repoRef } from '#/server/static-context'
import { createEntry, listEntries } from '#/server/static-store'

/**
 * Entries in a collection, in ra-data-simple-rest's dialect.
 *
 * Same shape as the database-backed resources, so the admin's existing
 * dataProvider drives these screens without knowing the records are files in a
 * git repository.
 */
export const Route = createFileRoute('/api/static/$collection/')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      try {
        const ref = await repoRef(getDb(env))
        const { collection } = await collectionFor(ref, params.collection)
        const entries = await listEntries(ref, collection)

        // Every entry is fetched already, so paging happens here rather than
        // over the API — these collections are small by nature.
        const url = new URL(request.url)
        const [start, end] = JSON.parse(
          url.searchParams.get('range') ?? '[0,99]',
        ) as [number, number]
        const page = entries.slice(start, end + 1)

        return Response.json(page, {
          headers: {
            'Content-Range': `${params.collection} ${start}-${start + Math.max(0, page.length - 1)}/${entries.length}`,
            'Access-Control-Expose-Headers': 'Content-Range',
          },
        })
      } catch (error) {
        return errorResponse(error)
      }
    },

    POST: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      try {
        const ref = await repoRef(getDb(env))
        const { collection } = await collectionFor(ref, params.collection)
        const body = (await request.json()) as Record<string, unknown>
        return Response.json(await createEntry(ref, collection, body), {
          status: 201,
        })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }),
)
