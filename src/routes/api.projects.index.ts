import { createFileRoute } from '@tanstack/react-router'
import { desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { projects } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { allows, can, principalFrom } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import { badSlug, provisionProject } from '#/server/projects/provision'

/**
 * The projects this node has built, and building another.
 *
 * `POST` is the whole of feature 9 from the outside: a name goes in, and a
 * running site on the operator's own Cloudflare account comes back. Nothing in
 * it touches a key of the platform's — the account is the operator's, and the
 * build comes from a public release.
 *
 * A collaborator may do this. What they may not do is decide *whose* account it
 * lands on, which is `infra:connect` and lives with the operator.
 */
export const Route = createFileRoute('/api/projects/')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!principal || !can(principal, 'projects:read')) {
        const said = 'Not allowed. This needs "projects:read".'
        return Response.json({ error: said, message: said }, { status: 403 })
      }

      const rows = await db.select().from(projects).orderBy(desc(projects.id)).limit(100)
      // Narrowed by the caller's own grant, so a collaborator scoped to their
      // own sees theirs and an operator sees all of them — the same rule that
      // scopes every other list on this node.
      return Response.json(
        rows.filter((row) => allows(principal, 'projects:read', row)),
      )
    },

    POST: async ({ request }) => {
      const env = getEnv(request)
      const db = getDb(env)
      if (!(await getEnabledFeatures(db)).includes('projects')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const principal = await principalFrom(env, db, request)
      if (!principal || !can(principal, 'projects:create')) {
        const said = 'Not allowed. This needs "projects:create".'
        return Response.json({ error: said, message: said }, { status: 403 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        slug?: string
        name?: string
      }
      const slug = String(body.slug ?? '').trim().toLowerCase()
      const wrong = badSlug(slug)
      if (wrong) {
        return Response.json({ error: wrong, message: wrong }, { status: 422 })
      }

      const [taken] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)
      if (taken && taken.status !== 'failed') {
        const said = `There is already a project called ${slug}.`
        return Response.json({ error: said, message: said }, { status: 409 })
      }

      /*
        The row first, then the infrastructure.

        A Worker created without a row behind it is a resource on somebody's
        account that this node has forgotten about, and the operator is the one
        who finds it. A row with nothing behind it is a failed provision, which
        is ordinary and retryable — the same reasoning master's pipeline uses,
        and it matters more here because the resources are not ours to clean up.
      */
      if (!taken) {
        await db.insert(projects).values({
          slug,
          name: body.name?.trim() || slug,
          status: 'provisioning',
          ownerUserId: principal.userId,
        })
      } else {
        await db
          .update(projects)
          .set({ status: 'provisioning', lastError: null })
          .where(eq(projects.slug, slug))
      }

      const outcome = await provisionProject(env, db, slug, {
        ownerUserId: principal.userId,
      })

      if (!outcome.ok) {
        await db
          .update(projects)
          .set({ status: 'failed', lastError: outcome.error })
          .where(eq(projects.slug, slug))
        return Response.json(
          { error: outcome.error, message: outcome.error, slug },
          { status: 502 },
        )
      }

      const [row] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
        .limit(1)
      return Response.json(row, { status: 201 })
    },
  }),
)
