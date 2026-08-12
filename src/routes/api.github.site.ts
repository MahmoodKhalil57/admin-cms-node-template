import { eq } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { githubConnections } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import {
  SiteError,
  connectExistingSite,
  createSiteFromTemplate,
  ensureExampleForm,
} from '#/server/github-site'
import { currentConnection, redactConnection } from '#/server/github-store'

const DEFAULT_TEMPLATE = 'MahmoodKhalil57/pure-frontend-saastarter'

/**
 * Creates a site from the template, or adopts one the user already has.
 *
 * Either way the node makes sure a published example form exists first, so the
 * site has something real to post to the moment Pages serves it.
 */
export const Route = createFileRoute('/api/github/site')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      if (!enabled.includes('github-pages')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const connection = await currentConnection(db)
      if (!connection) {
        return Response.json({ error: 'Connect GitHub first.' }, { status: 400 })
      }
      if (!env.PUBLIC_URL) {
        return Response.json(
          { error: 'This node does not know its own public URL.' },
          { status: 503 },
        )
      }

      const body = (await request.json().catch(() => ({}))) as {
        mode?: 'create' | 'connect'
        name?: string
        repoFullName?: string
      }

      // The form has to exist and be published before the site points at it,
      // or the first visitor gets a 404 from a site that looks finished.
      const formSlug = enabled.includes('forms')
        ? await ensureExampleForm(db)
        : 'early-access'

      const shared = {
        token: connection.accessToken,
        templateRepo: env.GITHUB_TEMPLATE_REPO ?? DEFAULT_TEMPLATE,
        backendUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
        formSlug,
        name: body.name ?? `${env.NODE_ID ?? 'site'}-website`,
      }

      try {
        const result =
          body.mode === 'connect'
            ? await connectExistingSite({
                ...shared,
                repoFullName: body.repoFullName ?? '',
              })
            : await createSiteFromTemplate(shared)

        await db
          .update(githubConnections)
          .set({
            repoOwner: result.owner,
            repoName: result.repo,
            pagesUrl: result.pagesUrl,
          })
          .where(eq(githubConnections.id, connection.id))

        return Response.json({
          ok: true,
          ...result,
          formSlug,
          connection: redactConnection(await currentConnection(db)),
        })
      } catch (error) {
        const message =
          error instanceof SiteError || error instanceof Error
            ? error.message
            : String(error)
        const status = error instanceof SiteError ? (error.status ?? 500) : 500
        return Response.json({ ok: false, error: message }, { status })
      }
    },
  }),
)
