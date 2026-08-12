import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { deleteResource, getResource, updateResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'

export const Route = createFileRoute('/api/$resource/$id')(
  serverRoute({
    GET: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      return getResource(db, await getEnabledFeatures(db), params.resource, params.id)
    },
    PUT: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      return updateResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        params.id,
        request,
      )
    },
    DELETE: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      return deleteResource(db, await getEnabledFeatures(db), params.resource, params.id)
    },
  }),
)
