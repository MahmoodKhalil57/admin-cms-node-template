import { createFileRoute } from '@tanstack/react-router'

import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'

export const Route = createFileRoute('/api/auth/$')(
  serverRoute(
    {
      GET: ({ request }) => getAuth(getEnv(request)).handler(request),
      POST: ({ request }) => getAuth(getEnv(request)).handler(request),
    },
    // Exempt from the profile gate: sign-out has to work for an account that cannot use anything else
    { gate: 'none' },
  ),
)
