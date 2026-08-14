import { createFileRoute } from '@tanstack/react-router'
import { getMigrations } from 'better-auth/db/migration'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { ensureFeatureRows } from '#/server/features'

interface SeedRequest {
  email: string
  password: string
  /** replace the owner's password when they already exist */
  reset?: boolean
  name?: string
  /** the master account this operator corresponds to */
  masterUserId?: string
}

/**
 * Finishes setting a node up, called by master right after the Worker is
 * uploaded.
 *
 * Two things happen here rather than in master:
 *
 *  - **Auth tables.** Better Auth owns its own schema and migrates itself
 *    through `getMigrations()`. Master applies the node's Drizzle migrations
 *    over the D1 HTTP API, but it cannot run Better Auth's introspection-driven
 *    DDL from outside.
 *  - **The owner account.** The password has to be hashed exactly the way
 *    sign-in will verify it, which means going through this node's own Better
 *    Auth instance. Master writing rows into the node's database directly would
 *    duplicate that hashing and drift from it.
 *
 * Idempotent: re-running applies nothing and leaves an existing owner alone,
 * because provisioning is retried.
 */
export const Route = createFileRoute('/api/internal/provision')(
  serverRoute(
    {
      POST: async ({ request }) => {
        const env = getEnv(request)

        const offered = request.headers.get('authorization')
        if (
          !env.PROVISION_TOKEN ||
          offered !== `Bearer ${env.PROVISION_TOKEN}`
        ) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = (await request.json()) as SeedRequest
        if (!body.email || !body.password) {
          return Response.json(
            { error: 'email and password are required' },
            { status: 400 },
          )
        }

        const auth = getAuth(env)

        const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
          auth.options,
        )
        const migrated = toBeCreated.length > 0 || toBeAdded.length > 0
        if (migrated) await runMigrations()

        // Give every catalog entry a row so the node has something to toggle.
        // Existing rows are left alone — the operator's choices survive a deploy,
        // and a feature added by a later build simply appears switched off.
        const featuresAdded = await ensureFeatureRows(getDb(env))

        const ctx = await auth.$context

        const existing = await ctx.internalAdapter.findUserByEmail(body.email)
        if (existing) {
          /*
            The owner is already here, which is the ordinary outcome of a
            reprovision. Their password is left alone unless master explicitly
            asks — a redeploy must not change somebody's credentials underneath
            them.

            When it does ask, the password is genuinely applied. It used to be
            returned by master without being set, which is the worst kind of
            wrong: a credential that looks real, is written down, and refuses to
            work.
          */
          if (!body.reset) {
            return Response.json({
              ok: true,
              migrated,
              featuresAdded,
              seeded: false,
              reset: false,
            })
          }

          const hash = await ctx.password.hash(body.password)
          const accounts = await ctx.adapter.findMany<{
            id: string
            providerId: string
          }>({
            model: 'account',
            where: [{ field: 'userId', value: existing.user.id }],
          })
          const credential = accounts.find(
            (account) => account.providerId === 'credential',
          )

          if (credential) {
            await ctx.adapter.update({
              model: 'account',
              where: [{ field: 'id', value: credential.id }],
              update: { password: hash },
            })
          } else {
            // Signed up by a code or a passkey and never given a password.
            // Linking one now is what makes the reset mean anything.
            await ctx.internalAdapter.linkAccount({
              userId: existing.user.id,
              accountId: existing.user.id,
              providerId: 'credential',
              password: hash,
            })
          }

          // Every live session ends. A reset that left the old ones running
          // would not be a reset.
          await ctx.adapter.deleteMany({
            model: 'session',
            where: [{ field: 'userId', value: existing.user.id }],
          })

          return Response.json({
            ok: true,
            migrated,
            featuresAdded,
            seeded: false,
            reset: true,
            userId: existing.user.id,
          })
        }

        const user = await ctx.internalAdapter.createUser({
          email: body.email,
          name: body.name ?? body.email,
          emailVerified: true,
          masterUserId: body.masterUserId ?? null,
        })

        // Without a credential account there is nothing for sign-in to check the
        // password against — a user row alone cannot log in.
        await ctx.internalAdapter.linkAccount({
          userId: user.id,
          accountId: user.id,
          providerId: 'credential',
          password: await ctx.password.hash(body.password),
        })

        return Response.json({
          ok: true,
          migrated,
          featuresAdded,
          seeded: true,
          userId: user.id,
          masterUserId: body.masterUserId ?? null,
        })
      },
    },
    // Exempt from the profile gate: master calls this with no session at all
    { gate: 'none' },
  ),
)
