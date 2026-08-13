import { createFileRoute } from '@tanstack/react-router'

import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import type { NodeEnv } from '#/server/env'
import { getAuth } from '#/server/auth'
import { DEFAULT_ROLE } from '#/server/team'

/**
 * Signing up from the website.
 *
 * Kept for a caller that wants to create an account and set a password in one
 * step — provisioning uses the same mechanism to seed the root admin. The site
 * no longer uses it: signing up there is asking for a code, which creates the
 * account on first use and never involves a password at all.
 *
 * The role is not a parameter here either. It is fixed to `default`, and the
 * database hook in the auth config holds the same line for every other path.
 */

const MAX_PER_HOUR = 10

function cors(request: Request): Record<string, string> {
  // The site posts from its own origin, which on a custom domain is this one.
  const origin = request.headers.get('origin') ?? '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  }
}

/**
 * How many accounts this caller has asked for lately.
 *
 * A public endpoint that creates rows needs a ceiling, or the first person who
 * notices it owns the user table. Counted in KV because it is the only store
 * here that expires on its own.
 */
async function tooMany(env: NodeEnv, request: Request): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? ''
  if (!ip || !env.KV) return false

  const hour = Math.floor(Date.now() / 3_600_000)
  const key = `signup:${hour}:${ip}`
  const seen = Number((await env.KV.get(key)) ?? '0')
  if (seen >= MAX_PER_HOUR) return true

  await env.KV.put(key, String(seen + 1), { expirationTtl: 3600 })
  return false
}

export const Route = createFileRoute('/api/public/signup')(
  serverRoute({
    OPTIONS: ({ request }) => new Response(null, { headers: cors(request) }),

    POST: async ({ request }) => {
      const env = getEnv(request)
      const headers = cors(request)

      if (await tooMany(env, request)) {
        return Response.json(
          { error: 'Too many attempts. Try again later.' },
          { status: 429, headers },
        )
      }

      const body = (await request.json().catch(() => ({}))) as {
        email?: string
        password?: string
        name?: string
      }
      const email = (body.email ?? '').trim().toLowerCase()
      const password = body.password ?? ''

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json(
          { error: 'That does not look like an email address.' },
          { status: 422, headers },
        )
      }
      if (password.length < 8) {
        return Response.json(
          { error: 'Use a password of at least 8 characters.' },
          { status: 422, headers },
        )
      }

      const ctx = await getAuth(env).$context
      const existing = await ctx.adapter.findOne({
        model: 'user',
        where: [{ field: 'email', value: email }],
      })
      if (existing) {
        // Deliberately the same shape of answer as success would be, so this
        // cannot be used to find out who already has an account here.
        return Response.json({ ok: true }, { headers })
      }

      const user = await ctx.internalAdapter.createUser({
        email,
        name: body.name?.trim() || email,
        emailVerified: true,
        // Not read from the request. There is no path here that can ask for
        // anything else.
        role: DEFAULT_ROLE,
      })
      await ctx.internalAdapter.linkAccount({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: await ctx.password.hash(password),
      })

      // Signed up, not signed in: the site posts to the normal sign-in
      // endpoint next, so there is one place that mints a session.
      return Response.json({ ok: true }, { headers })
    },
  }),
)
