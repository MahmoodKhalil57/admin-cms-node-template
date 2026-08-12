import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { deleteResource, getResource, updateResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { enabledFeatures, getEnv } from '#/server/env'

export const Route = createFileRoute('/api/$resource/$id')(
  serverRoute({
    GET: ({ request, params }) => {
      const env = getEnv(request)
      return getResource(
        getDb(env),
        enabledFeatures(env),
        params.resource,
        params.id,
      )
    },
    PUT: ({ request, params }) => {
      const env = getEnv(request)
      return updateResource(
        getDb(env),
        enabledFeatures(env),
        params.resource,
        params.id,
        request,
      )
    },
    DELETE: ({ request, params }) => {
      const env = getEnv(request)
      return deleteResource(
        getDb(env),
        enabledFeatures(env),
        params.resource,
        params.id,
      )
    },
  }),
)
