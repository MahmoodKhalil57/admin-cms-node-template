import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { createResource, listResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'
import { withFormsSync } from '#/server/forms-hook'

export const Route = createFileRoute('/api/$resource/')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      return listResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        new URL(request.url),
        await principalFrom(env, db, request),
      )
    },
    POST: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const response = await createResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        request,
        await principalFrom(env, db, request),
      )
      return withFormsSync(db, params.resource, 'created', response)
    },
  }),
)
