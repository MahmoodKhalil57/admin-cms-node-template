import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The node owns `/admin` and `/api`, nothing else.
 *
 * On a custom domain `/` belongs to the operator's own website, which is served
 * by GitHub Pages and never reaches this Worker. On the platform address there
 * is no website, so landing here means the admin panel was wanted.
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin' })
  },
})
