import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { createResource, listResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { enabledFeatures, getEnv } from '#/server/env'

export const Route = createFileRoute('/api/$resource/')(
  serverRoute({
    GET: ({ request, params }) => {
      const env = getEnv(request)
      return listResource(
        getDb(env),
        enabledFeatures(env),
        params.resource,
        new URL(request.url),
      )
    },
    POST: ({ request, params }) => {
      const env = getEnv(request)
      return createResource(
        getDb(env),
        enabledFeatures(env),
        params.resource,
        request,
      )
    },
  }),
)
