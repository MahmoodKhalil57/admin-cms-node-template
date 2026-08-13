import { createFileRoute } from '@tanstack/react-router'

import { AdminApp } from '#/components/admin-app'

/**
 * Catch-all beneath `/admin`, so react-admin's own URLs resolve.
 *
 * Everything the node serves lives under `/admin` or `/api`, because on a
 * custom domain those are the only prefixes routed to it — the rest of the
 * hostname is the operator's own website.
 */
export const Route = createFileRoute('/admin/$')({
  ssr: false,
  component: AdminApp,
})
