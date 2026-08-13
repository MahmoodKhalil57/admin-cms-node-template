/**
 * Typed wrapper for TanStack Start server-route handlers.
 *
 * `createFileRoute(...)({ server: { handlers } })` is supported at runtime —
 * `@tanstack/start-server-core`'s `createStartHandler` reads
 * `route.options.server.handlers` directly — but the published route-options
 * type does not include `server`, because `@tanstack/react-start` (1.168, the
 * latest release) has not caught up to `@tanstack/react-router` (1.170). The
 * scaffold's own `src/routes/mcp.ts` hits the same error.
 *
 * Keeping the cast here means the handlers stay fully typed at every call site,
 * and there is exactly one line to delete once the versions realign.
 */

export interface ServerHandlerCtx {
  request: Request
  params: Record<string, string>
}

export type ServerHandler = (
  ctx: ServerHandlerCtx,
) => Response | Promise<Response>

export type ServerHandlers = Partial<
  Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS', ServerHandler>
>

export interface ServerRouteOptions {
  /**
   * Whether an account with unfinished required details may call this.
   *
   * `'profile'` is the default, and the default is the strict one on purpose:
   * a gate you have to remember to add is a gate that is missing from whatever
   * route was written in a hurry. Opting out is a decision visible at the top
   * of the file that made it.
   *
   * `'none'` belongs to four kinds of route — the one that takes the answers,
   * the auth endpoints (so an account can always be signed out of), the public
   * endpoints (which serve strangers and must not behave differently for a
   * signed-in visitor), and the machine-to-machine ones master calls, which
   * carry no session at all.
   */
  gate?: 'profile' | 'none'
}

export function serverRoute(
  handlers: ServerHandlers,
  options: ServerRouteOptions = {},
) {
  const gated =
    options.gate === 'none' ? handlers : withProfileGate(handlers)

  // `never` is assignable to the route-options parameter, which is what lets
  // this pass while the upstream type is missing `server`.
  return { server: { handlers: gated } } as never
}

/**
 * Wraps every handler on a route with the profile gate.
 *
 * Done here rather than in each route because there is one way in and it should
 * have one door. The check itself resolves the caller once per request and
 * shares that with whatever the handler does next, so a gated route costs the
 * same lookups an ungated one already paid for.
 *
 * The imports are deliberately lazy. This module is reached by every server
 * route, and pulling the whole authorisation stack into all of them at import
 * time would put the database and the auth server in front of routes that touch
 * neither.
 */
function withProfileGate(handlers: ServerHandlers): ServerHandlers {
  const wrapped: ServerHandlers = {}

  for (const [method, handler] of Object.entries(handlers)) {
    if (!handler) continue
    wrapped[method as keyof ServerHandlers] = async (ctx) => {
      // A preflight carries no credentials and answers no question; holding one
      // up would break the request it is asking permission for.
      if (ctx.request.method === 'OPTIONS') return handler(ctx)

      const [{ getDb }, { getEnv }, { profileRefusal }] = await Promise.all([
        import('#/db'),
        import('#/server/env'),
        import('#/server/profile-gate'),
      ])
      const env = getEnv(ctx.request)
      const held = await profileRefusal(env, getDb(env), ctx.request)
      return held ?? handler(ctx)
    }
  }

  return wrapped
}
