import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { createResource, listResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'

export const Route = createFileRoute('/api/$resource/')(
  serverRoute({
    GET: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      return listResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        new URL(request.url),
      )
    },
    POST: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      return createResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        request,
      )
    },
  }),
)
