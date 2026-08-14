import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { can, principalFrom } from '#/server/authz'
import { mintCmsToken } from '#/server/cms-token'
import { sveltiaAccount } from '#/server/cms-proxy'

/**
 * A token for the browser that already has a session.
 *
 * The popup at `/api/cms/auth` exists because that is the flow Sveltia knows.
 * This exists because being asked to sign in to something you are already
 * signed in to is the wrong experience — and worse here, because the button it
 * shows says GitHub, which is neither what happens nor an account these editors
 * have.
 *
 * So the page asks for a token before the CMS loads, and if this browser is
 * recognised it opens signed in. Same token, same two checks, different door.
 *
 * Session only, deliberately. A key asking for one would be a key promoting
 * itself into a browser credential with a fresh expiry, which is a way around
 * the ceiling every key already has.
 */
export const Route = createFileRoute('/api/cms/token')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)

        const principal = await principalFrom(env, db, request)
        const answer = (body: unknown, status: number) =>
          Response.json(body, {
            status,
            // A token is in here when it succeeds. Nothing may keep a copy.
            headers: { 'Cache-Control': 'private, no-store' },
          })

        if (!principal || principal.viaKey) {
          return answer({ signedIn: false }, 401)
        }
        if (!can(principal, 'content:read')) {
          return answer(
            { signedIn: true, error: 'Your account cannot edit this site.' },
            403,
          )
        }

        return answer(
          {
            signedIn: true,
            account: sveltiaAccount(
              principal,
              await mintCmsToken(env, principal.userId),
            ),
          },
          200,
        )
      },
    },
    // Exempt from the profile gate: the CMS has to be able to open before it
    // can put a form asking for somebody's name on the screen.
    { gate: 'none' },
  ),
)
