import { eq, inArray } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  policies as policiesTable,
  roles as rolesTable,
  vendorMembers,
} from '#/db/schema'
import type { RoleCondition } from '#/db/schema'
import { permissionKeys } from '#/lib/permission-catalog'
import type { NodeEnv } from './env'
import { getAuth } from './auth'
import { getEnabledFeatures } from './features'
import { KEY_FORBIDDEN, bearerFor } from './api-keys'
import type { KeyBearer } from './api-keys'
import { EMPTY_GRANT, evaluate, grantAllows, intersect } from './policy'
import type { Grant, PolicyInput } from './policy'

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
  /**
   * The vendors this account acts for.
   *
   * Empty for everybody who is not one, which is most accounts and every
   * single-vendor node. A rule written as `{ vendorId: { mine: true } }` reads
   * against this, so the same policy serves every vendor without naming any.
   */
  vendorIds: Array<number>
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

  return grantFor(db, user, bearer)
}

/**
 * Everything a principal is, once it is known which account is asking.
 *
 * Split from the lookup because there is more than one way to arrive: a session
 * cookie, a key, and now a signed CMS token, which names an account without
 * carrying a session at all. All three end here, so all three get the same
 * answer about what that account may do.
 */
export async function principalForUserId(
  env: NodeEnv,
  db: NodeDb,
  userId: string,
): Promise<Principal | null> {
  const found = await (
    await getAuth(env).$context
  ).adapter.findOne({
    model: 'user',
    where: [{ field: 'id', value: userId }],
  })
  const user = (found as SessionUser | null) ?? null
  // A token naming an account that has since been removed names nothing.
  if (!user) return null
  return grantFor(db, user, null)
}

/**
 * Loads policies by key, in one query, in the order they were named.
 */
async function policiesFor(
  db: NodeDb,
  keys: Array<string>,
): Promise<Array<PolicyInput>> {
  if (!keys.length) return []
  return db.select().from(policiesTable).where(inArray(policiesTable.key, keys))
}

/**
 * Both gates, applied in order.
 *
 * The account's own role and policies decide what it may ever do. A key that
 * account minted decides what *this* holder may do with it. The second can only
 * ever take away — so the result is the intersection, and never a merge.
 *
 * This is the part worth being careful about. Checking only the account's grant
 * would make the key's scope decoration: an agent handed a read-only key could
 * write. Checking only the key's would make it an escalation: an agent handed a
 * generous key could reach past the person who minted it. Both are the same
 * mistake in opposite directions, and `intersect` is the only place either is
 * prevented.
 */
async function grantFor(
  db: NodeDb,
  user: SessionUser,
  bearer: KeyBearer | null,
): Promise<Principal> {
  // Seeded by master, so this is the account the node was handed over to.
  const isOwner = Boolean(user.masterUserId)
  // A permission for a feature that has since been switched off is not a
  // permission any more; intersecting here means one check covers both.
  const available = permissionKeys(await getEnabledFeatures(db))

  /** A key never carries what would let it reshape the node. */
  const ceiling = (keys: Array<string>) =>
    bearer ? keys.filter((key) => !KEY_FORBIDDEN.includes(key)) : keys

  /**
   * Narrows a grant by the key's own scope, when it has one.
   *
   * Evaluated against what the first gate already allows, so a scope written
   * as `*` means "everything this account has" rather than "everything the
   * node has" — the ceiling stays the account's, whatever the key says.
   */
  const scoped = async (grant: Grant): Promise<Grant> => {
    const scope = bearer?.scope
    if (!scope || scope.permissions === null) return grant
    return intersect(
      grant,
      evaluate({
        permissions: scope.permissions,
        conditions: scope.conditions,
        policies: await policiesFor(db, scope.policies),
        available: grant.permissions,
      }),
    )
  }

  // One query, and empty for almost everyone — a node with no marketplace has
  // no rows here at all.
  const vendorIds = (
    await db
      .select({ vendorId: vendorMembers.vendorId })
      .from(vendorMembers)
      .where(eq(vendorMembers.userId, user.id))
  ).map((row) => row.vendorId)

  const identity = {
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
    viaKey: Boolean(bearer),
    vendorIds,
  }

  if (isOwner) {
    const everything = ceiling(available)
    const grant = await scoped(
      evaluate({
        permissions: everything,
        conditions: {},
        policies: [],
        available: everything,
      }),
    )
    return {
      ...identity,
      // A key is never the root admin, even when it belongs to them. The
      // implicit grant exists so a person cannot be locked out; a secret in a
      // bundle has no such claim on it.
      isOwner: !bearer,
      roleKey: OWNER_ROLE,
      // Even the root admin's key is only what its scope allows. The implicit
      // grant exists so a person cannot be locked out, not so a secret they
      // minted inherits that.
      permissions: grant.permissions,
      grant,
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
  const grant = await scoped(
    evaluate({
      permissions: role?.permissions ?? [],
      conditions: role?.conditions ?? {},
      policies: await policiesFor(db, role?.policies ?? []),
      available: ceiling(available),
    }),
  )

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
): Array<Array<RoleCondition>> {
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
  return grantAllows(principal.grant, permission, record, {
    userId: principal.userId,
    vendorIds: principal.vendorIds,
  })
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
