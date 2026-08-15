import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { projects } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { allows, can, principalFrom } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import { destroyProject, provisionProject } from '#/server/projects/provision'

/**
 * One project, and taking it down.
 *
 * `DELETE` removes the Worker and the session store. **The database is kept**
 * unless somebody deliberately asks for it to go: it holds accounts, enquiries
 * and possibly orders, and losing that to a misclick on the wrong row is not a
 * recoverable mistake. Removing it is a second, explicit act.
 */
export const Route = createFileRoute('/api/projects/$slug')(
  serverRoute({
    GET: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      const [row] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, params.slug))
        .limit(1)
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

      if (
        !principal ||
        !can(principal, 'projects:read') ||
        !allows(principal, 'projects:read', row)
      ) {
        // Not found rather than forbidden: whether a project exists is itself
        // something a caller who cannot see it should not learn.
        return Response.json({ error: 'Not found' }, { status: 404 })
      }
      return Response.json(row)
    },

    /**
     * Builds it again, on whatever the current release is.
     *
     * Provisioning is find-or-create throughout, so this is the same call that
     * made it — which means it is also the repair for a project that failed
     * halfway, and the way an old one picks up a newer build. Without it a
     * project was frozen on the release it happened to be born on, and the only
     * remedy was destroying it and choosing a different name.
     */
    PUT: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      const [row] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, params.slug))
        .limit(1)
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

      // Rebuilding replaces what is running, so it is the create permission
      // rather than the read one — and narrowed to their own, like destroying.
      if (
        !principal ||
        !can(principal, 'projects:create') ||
        !allows(principal, 'projects:read', row)
      ) {
        const said = 'Not allowed. This needs "projects:create".'
        return Response.json({ error: said, message: said }, { status: 403 })
      }

      await db
        .update(projects)
        .set({ status: 'provisioning', lastError: null })
        .where(eq(projects.slug, params.slug))

      const outcome = await provisionProject(env, db, params.slug, {
        ownerUserId: row.ownerUserId,
      })
      if (!outcome.ok) {
        await db
          .update(projects)
          .set({ status: 'failed', lastError: outcome.error })
          .where(eq(projects.slug, params.slug))
        return Response.json(
          { error: outcome.error, message: outcome.error },
          { status: 502 },
        )
      }

      const [fresh] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, params.slug))
        .limit(1)
      return Response.json(fresh)
    },

    DELETE: async ({ request, params }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      const [row] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, params.slug))
        .limit(1)
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

      if (
        !principal ||
        !can(principal, 'projects:destroy') ||
        !allows(principal, 'projects:destroy', row)
      ) {
        const said = 'Not allowed. This needs "projects:destroy".'
        return Response.json({ error: said, message: said }, { status: 403 })
      }

      const alsoDatabase =
        new URL(request.url).searchParams.get('database') === 'delete'
      const outcome = await destroyProject(env, db, params.slug, { alsoDatabase })
      if (!outcome.ok) {
        return Response.json(
          { error: outcome.error, message: outcome.error },
          { status: 502 },
        )
      }
      return Response.json({ ok: true, keptDatabase: !alsoDatabase })
    },
  }),
)
