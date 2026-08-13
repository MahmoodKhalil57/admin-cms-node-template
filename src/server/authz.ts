import { eq, inArray } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { policies as policiesTable, roles as rolesTable } from '#/db/schema'
import type { RoleCondition } from '#/db/schema'
import { permissionKeys } from '#/lib/permission-catalog'
import type { NodeEnv } from './env'
import { getAuth } from './auth'
import { getEnabledFeatures } from './features'
import { KEY_FORBIDDEN, bearerFor } from './api-keys'
import { EMPTY_GRANT, evaluate, grantAllows } from './policy'
import type { Grant } from './policy'

/**
 * Who is asking, and what they may do.
 *
 * Two layers, because businesses need both. **Roles** answer "what kind of
 * access is this" — the part a business developer designs. **Conditions**
 * answer "over which records" — the part that makes one role usable by five
 * people who must not see each other's work.
 *
 * The owner is outside both. It is the account provisioning seeded, and it
 * always holds everything: a permission system that can lock the only operator
 * out of their own node is worse than none, and every route that could do that
 * has to be unable to.
 */

/**
 * The node-side half of the master account.
 *
 * Held implicitly by whoever provisioning seeded — not read from a row, so it
 * cannot be edited away. A second person can be given the matching role row by
 * invitation; this one is the guarantee that somebody always can.
 */
export const OWNER_ROLE = 'rootAdmin'

export interface Principal {
  userId: string
  email: string
  /** what the node knows them as, for fields it fills on their behalf */
  name: string | null
  /** the account master seeded — always allowed, never editable */
  isOwner: boolean
  /** a key acting as this account, rather than the person at a browser */
  viaKey: boolean
  roleKey: string | null
  permissions: Array<string>
  grant: Grant
}

interface SessionUser {
  id: string
  email: string
  name?: string | null
  role?: string | null
  masterUserId?: string | null
}

/**
 * One resolution per request, however many gates ask for it.
 *
 * Working out who is asking costs a session lookup, a role read and a policy
 * read. Routes ask once, and the profile gate in front of them asks again, so
 * without this every request pays twice for the same answer. Keyed on the
 * Request itself, which the runtime discards when the request ends.
 */
const perRequest = new WeakMap<Request, Promise<Principal | null>>()

/**
 * Who is asking: a signed-in person, or a key acting as one.
 *
 * A key resolves to the account it belongs to and then follows exactly the same
 * path, which is the point — a website holding a key is a user of this node,
 * and every gate downstream is unaware of the difference.
 */
export function principalFrom(
  env: NodeEnv,
  db: NodeDb,
  request: Request,
): Promise<Principal | null> {
  const seen = perRequest.get(request)
  if (seen) return seen

  const resolving = resolvePrincipal(env, db, request)
  perRequest.set(request, resolving)
  return resolving
}

async function resolvePrincipal(
  env: NodeEnv,
  db: NodeDb,
  request: Request,
): Promise<Principal | null> {
  let user: SessionUser | null = null

  const bearer = await bearerFor(
    db,
    request.headers.get('authorization'),
    request,
  )
  if (bearer) {
    const found = await (
      await getAuth(env).$context
    ).adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: bearer.userId }],
    })
    user = (found as SessionUser | null) ?? null
    // A key whose account has since been removed is a key to nothing.
    if (!user) return null
  } else {
    const session = await getAuth(env).api.getSession({
      headers: request.headers,
    })
    if (!session) return null
    user = session.user as unknown as SessionUser
  }
  // Seeded by master, so this is the account the node was handed over to.
  const isOwner = Boolean(user.masterUserId)
  // A permission for a feature that has since been switched off is not a
  // permission any more; intersecting here means one check covers both.
  const available = permissionKeys(await getEnabledFeatures(db))

  /** A key never carries what would let it reshape the node. */
  const ceiling = (keys: Array<string>) =>
    bearer ? keys.filter((key) => !KEY_FORBIDDEN.includes(key)) : keys

  const identity = {
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
    viaKey: Boolean(bearer),
  }

  if (isOwner) {
    const everything = ceiling(available)
    return {
      ...identity,
      // A key is never the root admin, even when it belongs to them. The
      // implicit grant exists so a person cannot be locked out; a secret in a
      // bundle has no such claim on it.
      isOwner: !bearer,
      roleKey: OWNER_ROLE,
      permissions: everything,
      grant: evaluate({
        permissions: everything,
        conditions: {},
        policies: [],
        available: everything,
      }),
    }
  }

  const roleKey = user.role ?? null
  if (!roleKey) {
    return {
      ...identity,
      isOwner: false,
      roleKey: null,
      permissions: [],
      grant: EMPTY_GRANT,
    }
  }

  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.key, roleKey))
    .limit(1)

  // Policies → roles → users: the role names them, and this is where the names
  // become rules. Read in one query; a role with none skips it entirely.
  const attached = role?.policies ?? []
  const rules = attached.length
    ? await db
        .select()
        .from(policiesTable)
        .where(inArray(policiesTable.key, attached))
    : []

  const grant = evaluate({
    permissions: role?.permissions ?? [],
    conditions: role?.conditions ?? {},
    policies: rules,
    available: ceiling(available),
  })

  return {
    ...identity,
    isOwner: false,
    roleKey,
    permissions: grant.permissions,
    grant,
  }
}

export function can(principal: Principal | null, permission: string): boolean {
  if (!principal) return false
  if (principal.isOwner) return true
  return principal.permissions.includes(permission)
}

/**
 * The ways a permission is allowed, read as *any of*.
 *
 * An empty list means no narrowing — the caller reaches everything the
 * permission covers.
 */
export function allowedWays(
  principal: Principal | null,
  permission: string,
): Array<RoleCondition> {
  if (!principal || principal.isOwner) return []
  return principal.grant.allow[permission] ?? []
}

/** The ways a permission is taken away, read as *none of*. */
export function deniedWays(
  principal: Principal | null,
  permission: string,
): Array<RoleCondition> {
  if (!principal || principal.isOwner) return []
  return principal.grant.deny[permission] ?? []
}

/**
 * Whether a record falls inside a narrowed grant.
 *
 * Applied to rows on their way out and to writes on their way in — a condition
 * that only filtered lists would be a display preference, not a permission.
 */
export function allows(
  principal: Principal | null,
  permission: string,
  record: Record<string, unknown>,
): boolean {
  if (!principal) return false
  if (principal.isOwner) return true
  return grantAllows(principal.grant, permission, record, principal.userId)
}

/**
 * The gate for routes outside the generic REST layer.
 *
 * Returns a response when the caller may not proceed, and null when they may —
 * so a route reads `const denied = await require(...); if (denied) return denied`
 * and cannot accidentally continue past a refusal.
 */
export async function requirePermission(
  env: NodeEnv,
  db: NodeDb,
  request: Request,
  permission: string,
): Promise<Response | null> {
  const principal = await principalFrom(env, db, request)
  if (!principal) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return can(principal, permission) ? null : forbidden(permission)
}

export function forbidden(permission: string): Response {
  return Response.json(
    { error: `Not allowed. This needs "${permission}".` },
    { status: 403 },
  )
}
