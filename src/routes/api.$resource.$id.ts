import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { deleteResource, getResource, updateResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { principalFrom } from '#/server/authz'
import { withFormsSync } from '#/server/forms-hook'

export const Route = createFileRoute('/api/$resource/$id')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      return getResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        params.id,
        await principalFrom(env, db, request),
      )
    },
    PUT: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const response = await updateResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        params.id,
        request,
        await principalFrom(env, db, request),
      )
      // A form saved here is half the change; the site's declaration is the
      // other half, and leaving it stale is what "synced" has to rule out.
      return withFormsSync(db, params.resource, 'updated', response)
    },
    DELETE: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      const response = await deleteResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        params.id,
        await principalFrom(env, db, request),
      )
      return withFormsSync(db, params.resource, 'deleted', response)
    },
  }),
)
