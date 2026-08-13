import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { roles as rolesTable } from '#/db/schema'
import type { RoleCondition } from '#/db/schema'
import { permissionKeys } from '#/lib/permission-catalog'
import type { NodeEnv } from './env'
import { getAuth } from './auth'
import { getEnabledFeatures } from './features'
import { KEY_FORBIDDEN, bearerFor } from './api-keys'

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
  /** the account master seeded — always allowed, never editable */
  isOwner: boolean
  roleKey: string | null
  permissions: Array<string>
  conditions: Record<string, RoleCondition>
}

interface SessionUser {
  id: string
  email: string
  role?: string | null
  masterUserId?: string | null
}

/**
 * Who is asking: a signed-in person, or a key acting as one.
 *
 * A key resolves to the account it belongs to and then follows exactly the same
 * path, which is the point — a website holding a key is a user of this node,
 * and every gate downstream is unaware of the difference.
 */
export async function principalFrom(
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

  if (isOwner) {
    const everything = permissionKeys(await getEnabledFeatures(db))
    return {
      userId: user.id,
      email: user.email,
      // A key is never the root admin, even when it belongs to them. The
      // implicit grant exists so a person cannot be locked out; a secret in a
      // bundle has no such claim on it.
      isOwner: !bearer,
      roleKey: OWNER_ROLE,
      permissions: bearer
        ? everything.filter((key) => !KEY_FORBIDDEN.includes(key))
        : everything,
      conditions: {},
    }
  }

  const roleKey = user.role ?? null
  if (!roleKey) {
    return {
      userId: user.id,
      email: user.email,
      isOwner: false,
      roleKey: null,
      permissions: [],
      conditions: {},
    }
  }

  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.key, roleKey))
    .limit(1)

  // A permission for a feature that has since been switched off is not a
  // permission any more; intersecting here means one check covers both.
  const available = new Set(permissionKeys(await getEnabledFeatures(db)))

  const held = (role?.permissions ?? []).filter((key) => available.has(key))

  return {
    userId: user.id,
    email: user.email,
    isOwner: false,
    roleKey,
    // A key never carries the permissions that would let it reshape the node,
    // however generous the role behind it is.
    permissions: bearer
      ? held.filter((key) => !KEY_FORBIDDEN.includes(key))
      : held,
    conditions: role?.conditions ?? {},
  }
}

export function can(principal: Principal | null, permission: string): boolean {
  if (!principal) return false
  if (principal.isOwner) return true
  return principal.permissions.includes(permission)
}

/** How this principal's grant is narrowed, if it is. */
export function conditionFor(
  principal: Principal | null,
  permission: string,
): RoleCondition | null {
  if (!principal || principal.isOwner) return null
  const condition = principal.conditions[permission]
  return condition && Object.keys(condition).length > 0 ? condition : null
}

/**
 * Whether a record falls inside a narrowed grant.
 *
 * Applied to rows on their way out and to writes on their way in — a condition
 * that only filtered lists would be a display preference, not a permission.
 */
export function matchesCondition(
  condition: RoleCondition | null,
  record: Record<string, unknown>,
  principal: Principal,
): boolean {
  if (!condition) return true

  return Object.entries(condition).every(([field, rule]) => {
    const value = record[field]
    if (rule.self) return String(value) === principal.userId
    if (rule.eq !== undefined) return String(value) === String(rule.eq)
    if (rule.in) return rule.in.map(String).includes(String(value))
    return true
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
