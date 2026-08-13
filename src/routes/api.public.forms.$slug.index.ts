import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import {
  corsHeaders,
  preflight,
  publicFormDefinition,
} from '#/server/public-forms'

export const Route = createFileRoute('/api/public/forms/$slug/')(
  serverRoute(
    {
      OPTIONS: ({ request }) =>
        preflight(
          corsHeaders(
            getEnv(request).ALLOWED_ORIGINS,
            request.headers.get('origin'),
          ),
        ),
      GET: async ({ request, params }) => {
        const env = getEnv(request)
        const cors = corsHeaders(
          env.ALLOWED_ORIGINS,
          request.headers.get('origin'),
        )
        const db = getDb(env)

        // Forms being off is indistinguishable from the form not existing — a
        // node should not advertise what it is not running.
        if (!(await getEnabledFeatures(db)).includes('forms')) {
          return Response.json(
            { error: 'Unknown form' },
            { status: 404, headers: cors },
          )
        }
        return publicFormDefinition(env, db, params.slug, request, cors)
      },
    },
    // Exempt from the profile gate: public: serves strangers, and must not differ for a signed-in one
    { gate: 'none' },
  ),
)
