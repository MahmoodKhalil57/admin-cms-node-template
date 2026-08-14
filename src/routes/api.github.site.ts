import { eq } from 'drizzle-orm'
import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { githubConnections } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { requirePermission } from '#/server/authz'
import { getEnabledFeatures } from '#/server/features'
import {
  SiteError,
  connectExistingSite,
  createSiteFromTemplate,
  ensureExampleForm,
} from '#/server/github-site'
import { currentConnection, redactConnection } from '#/server/github-store'
import { applyPagesDomain } from '#/server/domains'
import { getSettings, publicApiBase } from '#/server/settings'
import { ensureRepoHook } from '#/server/repo-hook'

const DEFAULT_TEMPLATE = 'MahmoodKhalil57/pure-frontend'

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
      const denied = await requirePermission(
        env,
        getDb(env),
        request,
        'website:manage',
      )
      if (denied) return denied

      const db = getDb(env)
      const enabled = await getEnabledFeatures(db)
      if (!enabled.includes('github-pages')) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const connection = await currentConnection(db)
      if (!connection) {
        return Response.json(
          { error: 'Connect GitHub first.' },
          { status: 400 },
        )
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

      // The template stores an origin and appends `/api/f/<slug>` itself, so
      // it must not be handed an address that already ends in `/api` — that
      // builds `/api/api/f/...` and 404s.
      const backendUrl = publicApiBase(env, await getSettings(db)).replace(
        /\/api$/,
        '',
      )

      const shared = {
        token: connection.accessToken,
        templateRepo: env.GITHUB_TEMPLATE_REPO ?? DEFAULT_TEMPLATE,
        backendUrl,
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

        // A domain already set up belongs to this site now — including when a
        // site is recreated or swapped, which otherwise leaves the domain
        // pointing at a repo that no longer serves it.
        const settings = await getSettings(db)
        if (settings.customDomain) {
          await applyPagesDomain(
            connection.accessToken,
            result.owner,
            result.repo,
            settings.customDomain,
          )
        }

        /*
          Register the push webhook as part of setting the site up.

          It was a second button, and a second button that everybody had to
          press: without the hook, an edit made on github.com leaves the node
          behind, which is a silent kind of wrong. Nobody was choosing not to
          have it — they were choosing between two clicks and one.

          Never allowed to fail the site. A repository that exists without a
          hook is a working site with a gap somebody can close from this screen;
          a repository that failed to be created is nothing at all. So the
          outcome is reported alongside the result rather than thrown.
        */
        let syncHook: { id: number; created: boolean } | null = null
        let syncHookError: string | null = null
        try {
          const registered = await ensureRepoHook(
            db,
            {
              token: connection.accessToken,
              owner: result.owner,
              repo: result.repo,
            },
            `${publicApiBase(env, settings)}/api/webhooks/github`,
          )
          syncHook = { id: registered.hookId, created: registered.created }
        } catch (error) {
          syncHookError =
            error instanceof Error ? error.message : 'Could not register it.'
        }

        return Response.json({
          ok: true,
          ...result,
          formSlug,
          syncHook,
          syncHookError,
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
