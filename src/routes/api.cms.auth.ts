import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { can, principalFrom } from '#/server/authz'
import { mintCmsToken } from '#/server/cms-token'

/**
 * Signing in to the repo-defined CMS, with this node's own accounts.
 *
 * Sveltia's OAuth flow is a popup: it opens `{base_url}/auth`, waits for that
 * window to say who it is, and takes a token from it. Normally the window on
 * the other end is GitHub's. Here it is this route, and the answer comes from
 * the session cookie the person already has — so signing in to the CMS is
 * signing in to the site, and there is one set of accounts rather than two.
 *
 * Nobody is asked for a GitHub password, and nobody is handed a GitHub token.
 * What comes back is a short-lived statement about *this node's* account, which
 * only the proxy in front of the API knows how to read.
 *
 * The sign-in page is the site's own `/login`. Reused rather than rebuilt: it
 * already does magic links, one-time codes and passkeys, and a second login
 * page would be a second thing to keep in step and a second thing to get wrong.
 */

const PROVIDER = 'github'

/**
 * The handshake Sveltia expects, exactly.
 *
 * The popup announces itself, the opener answers, and only then is the token
 * sent — and sent to the origin the opener replied from rather than to `*`, so
 * it lands in the window that asked for it and nowhere else.
 */
function handshake(payload: Record<string, unknown>, ok: boolean): Response {
  const state = ok ? 'success' : 'error'
  const body = JSON.stringify({ provider: PROVIDER, ...payload })

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><script>
(() => {
  window.addEventListener('message', ({ data, origin }) => {
    if (data === 'authorizing:${PROVIDER}') {
      window.opener?.postMessage(
        'authorization:${PROVIDER}:${state}:' + ${JSON.stringify(body)},
        origin
      );
    }
  });
  window.opener?.postMessage('authorizing:${PROVIDER}', '*');
})();
</script></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        // The token is in this document. Nothing may keep a copy.
        'Cache-Control': 'private, no-store',
      },
    },
  )
}

export const Route = createFileRoute('/api/cms/auth')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        const principal = await principalFrom(env, db, request)

        if (!principal) {
          // Not signed in, so there is nothing to hand back yet. The popup goes
          // to the site's login page and returns here afterwards, which keeps
          // the whole exchange inside the one window Sveltia is watching.
          const back = new URL(request.url)
          const login = new URL('/login', back.origin)
          login.searchParams.set('next', back.pathname + back.search)
          return Response.redirect(login.toString(), 302)
        }

        // The CMS is for people who edit the site. Anyone else gets a refusal
        // they can read, rather than an editor full of empty collections.
        if (!can(principal, 'content:read')) {
          return handshake(
            {
              error: 'Your account cannot edit this site.',
              errorCode: 'FORBIDDEN',
            },
            false,
          )
        }

        return handshake(
          { token: await mintCmsToken(env, principal.userId) },
          true,
        )
      },
    },
    // Exempt from the profile gate: signing in comes before anything can be
    // asked of the account, and the refusal is JSON the popup cannot render.
    { gate: 'none' },
  ),
)
