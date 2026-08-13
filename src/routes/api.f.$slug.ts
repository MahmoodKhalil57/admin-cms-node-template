import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { acceptSubmission, corsHeaders, preflight } from '#/server/public-forms'

/**
 * The short submission endpoint the static template posts to.
 *
 * `/api/f/<slug>` is the address baked into the template's markup and its
 * builder, so the node answers there as well as at the longer
 * `/api/public/forms/<slug>/submissions`. Same handler — this is an alias, not
 * a second implementation.
 */
export const Route = createFileRoute('/api/f/$slug')(
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
