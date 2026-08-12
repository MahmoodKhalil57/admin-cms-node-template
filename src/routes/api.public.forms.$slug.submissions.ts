import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { acceptSubmission, corsHeaders, preflight } from '#/server/public-forms'

export const Route = createFileRoute('/api/public/forms/$slug/submissions')(
  serverRoute({
    OPTIONS: ({ request }) =>
      preflight(
        corsHeaders(getEnv(request).ALLOWED_ORIGINS, request.headers.get('origin')),
      ),
    POST: async ({ request, params }) => {
      const env = getEnv(request)
      const cors = corsHeaders(env.ALLOWED_ORIGINS, request.headers.get('origin'))
      const db = getDb(env)

      if (!(await getEnabledFeatures(db)).includes('forms')) {
        return Response.json({ error: 'Unknown form' }, { status: 404, headers: cors })
      }
      return acceptSubmission(db, params.slug, request, cors)
    },
  }),
)
