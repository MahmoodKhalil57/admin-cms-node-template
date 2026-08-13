import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { deleteResource, getResource, updateResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { withFormsSync } from '#/server/forms-hook'

export const Route = createFileRoute('/api/$resource/$id')(
  serverRoute({
    GET: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      return getResource(db, await getEnabledFeatures(db), params.resource, params.id)
    },
    PUT: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      const response = await updateResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        params.id,
        request,
      )
      // A form saved here is half the change; the site's declaration is the
      // other half, and leaving it stale is what "synced" has to rule out.
      return withFormsSync(db, params.resource, 'updated', response)
    },
    DELETE: async ({ request, params }) => {
      const db = getDb(getEnv(request))
      const response = await deleteResource(
        db,
        await getEnabledFeatures(db),
        params.resource,
        params.id,
      )
      return withFormsSync(db, params.resource, 'deleted', response)
    },
  }),
)
