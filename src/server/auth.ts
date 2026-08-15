import { betterAuth } from 'better-auth'
import { emailOTP } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { APIError, createAuthMiddleware } from 'better-auth/api'

import type { NodeEnv } from './env'

/**
 * This node's authentication.
 *
 * Every node owns its own users, in its own D1 — there is no shared identity
 * and no federation from master. What links the two is `masterUserId` on the
 * user row: master seeds the node's first operator and records which master
 * account it came from, so the two can be related later without either side
 * having to trust the other at request time.
 *
 * People sign in with a code sent to their address, not a password. Passwords
 * on a site like this are a liability someone else eventually pays for: they
 * are reused, they are phished, and every one of them is a secret this node has
 * to keep. A six-digit code that expires is not worth stealing.
 *
 * One exception, and it is deliberate. The account provisioning seeded — the
 * root admin — can still sign in with its password, because the node has to be
 * usable before anyone has wired mail up. It is the account that creates the
 * roles, invites the team and mints the first keys; making that depend on a
 * working mail sender means a node that cannot be set up until it can already
 * send email. Everyone else, including anyone the root admin later invites,
 * goes through the code.
 *
 * Built per-request rather than at module scope, because the D1 binding does
 * not exist until a request is in flight. The cache keeps it to one instance
 * per isolate.
 */
function createAuth(env: NodeEnv) {
  return betterAuth({
    // The raw D1 binding, not a Drizzle adapter: Better Auth's `getMigrations()`
    // only works with its built-in Kysely adapter, and that is what lets
    // provisioning create the auth tables in a brand-new database.
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    // baseURL is deliberately unset so Better Auth infers it from the request.
    // One built artifact serves every node, and each answers on its own
    // hostname, so a baked-in URL would be wrong for all but one of them.
    basePath: '/api/auth',
    plugins: [
      /**
       * Passkeys, for the people who will use this every day.
       *
       * A code in an inbox is the floor: it always works, on any device, for
       * someone who has just arrived. A passkey is the ceiling — nothing to
       * type, nothing to intercept, and the private half never leaves the
       * device it was made on. Both are offered because they answer different
       * moments rather than competing.
       *
       * The relying party is left to be inferred from the request. Every node
       * answers on its own hostname and an operator can move theirs to a domain
       * they own, so a baked-in rpID would be wrong for all but one of them —
       * the same reason baseURL is unset above.
       */
      passkey({
        rpName: 'adminCms',
        authenticatorSelection: {
          // Let the device decide between its own biometrics and a security
          // key; refusing either narrows who can use this for no gain.
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        // A code is not an invitation. An address nobody has heard of gets an
        // account at the lowest role, the same as signing up on the site does.
        disableSignUp: false,
        async sendVerificationOTP({ email, otp }) {
          const [{ sendMail }, { getDb }, { getSettings }] = await Promise.all([
            import('./mailer'),
            import('#/db'),
            import('./settings'),
          ])
          const settings = await getSettings(getDb(env))
          const workspace = settings.customDomain ?? env.ORIGIN_HOST ?? 'this workspace'
          await sendMail(
            env,
            {
              to: email,
              subject: `${otp} is your sign-in code`,
              text: `Your sign-in code for ${workspace} is ${otp}.\n\nIt expires in ten minutes. If you did not ask for it, ignore this — it is useless on its own.`,
              html: `<p>Your sign-in code for <strong>${workspace}</strong> is:</p><p style="font:600 30px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.18em;margin:18px 0">${otp}</p><p style="font-size:13px;color:#4e737a">It expires in ten minutes. If you did not ask for it, ignore this — it is useless on its own.</p>`,
            },
            settings.customDomain,
          )
        },
      }),
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      /**
       * Better Auth owns the reset: it mints the token, expires it and checks
       * it on the way back. All that was missing was a way to deliver the
       * link, which is the only part specific to this node.
       */
      sendResetPassword: async ({ user, url }) => {
        const [{ sendMail, resetMail }, { getDb }, { getSettings }] =
          await Promise.all([
            import('./mailer'),
            import('#/db'),
            import('./settings'),
          ])
        const settings = await getSettings(getDb(env))
        await sendMail(
          env,
          resetMail({
            to: user.email,
            url,
            workspace: settings.customDomain ?? env.ORIGIN_HOST ?? 'this workspace',
          }),
          settings.customDomain,
        )
      },
    },
    user: {
      additionalFields: {
        masterUserId: { type: 'string', required: false, input: false },
        /**
         * The key of a role row, not a fixed enum. What roles exist is the
         * business's decision, so this column names one rather than defining
         * it. `input: false` because nobody sets their own.
         */
        role: { type: 'string', required: false, input: false },
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 },
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * Anyone arriving without a role arrives at the bottom.
           *
           * Signing up on the site and signing in with a code both create
           * accounts, and neither asks what the account should be able to do.
           * Deciding that here means there is no path that can be talked into
           * creating a privileged account — the invitation flow sets the role
           * explicitly, and everything else lands on `default`.
           */
          before: async (user) => ({
            data: {
              ...user,
              role: (user as { role?: string }).role || 'default',
            },
          }),
          /**
           * And every account that gets created is counted.
           *
           * Here rather than on the signup route because there is more than
           * one way in — a form, a one-time code, an invitation — and a meter
           * that only saw one of them would undercount from the day the second
           * was used. `record` swallows its own failures, so this cannot be
           * the reason somebody fails to sign up.
           */
          after: async (user) => {
            // Imported here rather than at the top, like everything else this
            // file reaches for: the database module imports the schema, which
            // imports back this way, and a static import would close the loop.
            const [{ record }, { getDb }] = await Promise.all([
              import('./events'),
              import('#/db'),
            ])
            await record(getDb(env), {
              name: 'user.signed_up',
              subjectType: 'users',
              subjectId: (user as { id?: string }).id,
            })
          },
        },
      },
    },
    hooks: {
      /**
       * Passwords are for the root admin only.
       *
       * Refused here rather than by leaving the endpoint off, because the
       * endpoint is what the root admin uses. The check is on the account, not
       * on the request, so there is nothing a caller can send to pass it.
       */
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return
        const email = String(
          (ctx.body as { email?: string } | undefined)?.email ?? '',
        ).toLowerCase()
        if (!email) return

        const found = (await ctx.context.adapter.findOne({
          model: 'user',
          where: [{ field: 'email', value: email }],
        })) as { masterUserId?: string | null } | null

        // Unknown addresses fall through: answering differently here would say
        // which addresses have accounts.
        if (found && !found.masterUserId) {
          throw new APIError('BAD_REQUEST', {
            message: 'Use the code we email you instead of a password.',
          })
        }
      }),
    },
    /**
     * The website signs people in too, and on a custom domain it is the same
     * origin as this API. A site still on github.io is not, so it is named
     * here — Better Auth refuses an origin it was not told about, which is the
     * behaviour worth keeping.
     */
    trustedOrigins: (request) => {
      const origin = request?.headers.get('origin')
      return origin ? [origin] : []
    },
  })
}

export type NodeAuth = ReturnType<typeof createAuth>

const cache = new WeakMap<NodeEnv, NodeAuth>()

export function getAuth(env: NodeEnv): NodeAuth {
  const hit = cache.get(env)
  if (hit) return hit

  const auth = createAuth(env)
  cache.set(env, auth)
  return auth
}
