import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { roles as rolesTable } from '#/db/schema'
import type { RoleCondition } from '#/db/schema'
import { permissionKeys } from '#/lib/permission-catalog'
import type { NodeEnv } from './env'
import { getAuth } from './auth'
import { getEnabledFeatures } from './features'

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

export const OWNER_ROLE = 'owner'

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

/** The signed-in principal, or null when there is no session. */
export async function principalFrom(
  env: NodeEnv,
  db: NodeDb,
  request: Request,
): Promise<Principal | null> {
  const session = await getAuth(env).api.getSession({ headers: request.headers })
  if (!session) return null

  const user = session.user as unknown as SessionUser
  // Seeded by master, so this is the account the node was handed over to.
  const isOwner = Boolean(user.masterUserId)

  if (isOwner) {
    return {
      userId: user.id,
      email: user.email,
      isOwner: true,
      roleKey: OWNER_ROLE,
      permissions: permissionKeys(await getEnabledFeatures(db)),
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

  return {
    userId: user.id,
    email: user.email,
    isOwner: false,
    roleKey,
    permissions: (role?.permissions ?? []).filter((key) => available.has(key)),
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
