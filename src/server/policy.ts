import type { RoleCondition } from '#/db/schema'

/**
 * Working out what a role actually reaches.
 *
 * The inputs are a role's own grant and the policies attached to it. The output
 * is one object every gate downstream reads — the REST layer to build a WHERE
 * clause, the routes to check a single record, the panel to decide what to draw.
 * Keeping the arithmetic here means there is one place to be right, and one
 * place to test.
 *
 * Three rules, in order:
 *
 * 1. **Allows accumulate, and their conditions widen.** Two policies granting
 *    `submissions:read`, one for the enquiries desk and one for wholesale, give
 *    a role that reaches both. So a permission's allowed conditions are a list
 *    read as *any of* — never merged into one object, which would silently turn
 *    two grants into an impossible intersection.
 *
 * 2. **Denies beat allows.** Not "are subtracted from" — beat. A deny with no
 *    condition removes the permission outright, whatever grants it afterwards.
 *    A rule that a later, more generous role could undo is not a rule.
 *
 * 3. **An unconditional allow means no narrowing at all.** Represented by an
 *    empty list rather than an empty condition, because "allowed everywhere"
 *    and "allowed where nothing is true" are opposite answers and must not
 *    share a shape.
 */

/** A policy as the evaluator needs it, whatever row or literal it came from. */
export interface PolicyInput {
  key: string
  effect: string
  permissions: Array<string>
  condition: RoleCondition
}

export interface Grant {
  /** every permission held, after denials */
  permissions: Array<string>
  /**
   * permission -> the ways it is allowed, read as *any of*.
   * An empty list means allowed with no narrowing.
   */
  allow: Record<string, Array<RoleCondition>>
  /**
   * permission -> conditions that take it away, read as *none of*.
   * A permission denied outright is absent from `permissions` instead.
   */
  deny: Record<string, Array<RoleCondition>>
}

export const EMPTY_GRANT: Grant = { permissions: [], allow: {}, deny: {} }

function isEmpty(condition: RoleCondition | undefined): boolean {
  return !condition || Object.keys(condition).length === 0
}

/**
 * Which permissions a policy speaks about.
 *
 * `*` is expanded against what the node currently offers rather than stored
 * expanded, so a policy written today still covers a permission added tomorrow.
 */
function subjects(
  policy: PolicyInput,
  available: Array<string>,
): Array<string> {
  if (policy.permissions.includes('*')) return available
  return policy.permissions.filter((key) => available.includes(key))
}

export function evaluate(input: {
  /** the role's own grant, kept because a one-off rule deserves no ceremony */
  permissions: Array<string>
  conditions: Record<string, RoleCondition>
  policies: Array<PolicyInput>
  /** every permission the node currently offers, features considered */
  available: Array<string>
}): Grant {
  const available = new Set(input.available)
  const allow: Record<string, Array<RoleCondition>> = {}
  const deny: Record<string, Array<RoleCondition>> = {}
  /** permissions a deny removed outright, which nothing later can restore */
  const revoked = new Set<string>()
  /**
   * Permissions already held with no narrowing.
   *
   * Tracked separately rather than inferred from an empty list, because "no
   * narrowing" and "not seen yet" are both empty lists and mean opposite
   * things. Reading one as the other turns a scoped grant into a total one.
   */
  const unconditional = new Set<string>()

  const addAllow = (permission: string, condition: RoleCondition | undefined) => {
    // An unconditional grant makes every narrowing beside it irrelevant: the
    // list is read as *any of*, and "anywhere" already satisfies it.
    if (unconditional.has(permission)) return
    if (isEmpty(condition)) {
      unconditional.add(permission)
      allow[permission] = []
      return
    }
    ;(allow[permission] ??= []).push(condition!)
  }

  // The role's own grant first, so a policy can only ever add to it or, by
  // denying, take it away.
  for (const permission of input.permissions) {
    if (!available.has(permission)) continue
    addAllow(permission, input.conditions[permission])
  }

  // Allows before denies, so a deny is applied to everything it could reach
  // regardless of the order the policies happen to sit in.
  const attached = input.policies
  for (const policy of attached.filter((entry) => entry.effect !== 'deny')) {
    for (const permission of subjects(policy, input.available)) {
      addAllow(permission, policy.condition)
    }
  }

  for (const policy of attached.filter((entry) => entry.effect === 'deny')) {
    for (const permission of subjects(policy, input.available)) {
      if (isEmpty(policy.condition)) {
        revoked.add(permission)
        continue
      }
      ;(deny[permission] ??= []).push(policy.condition)
    }
  }

  for (const permission of revoked) {
    delete allow[permission]
    delete deny[permission]
  }

  return {
    permissions: Object.keys(allow),
    allow,
    deny,
  }
}

/**
 * Whether one record falls inside a grant.
 *
 * The same arithmetic the WHERE clause does, applied to a single row — used on
 * writes, where there is no query to narrow and the record has to be checked
 * against the rule directly. A condition that only filtered lists would be a
 * display preference rather than a permission.
 */
export function grantAllows(
  grant: Grant,
  permission: string,
  record: Record<string, unknown>,
  userId: string,
): boolean {
  if (!grant.permissions.includes(permission)) return false

  const ways = grant.allow[permission] ?? []
  const allowed =
    ways.length === 0 || ways.some((way) => matches(way, record, userId))
  if (!allowed) return false

  const refusals = grant.deny[permission] ?? []
  return !refusals.some((refusal) => matches(refusal, record, userId))
}

/** Whether a record satisfies every field of one condition. */
export function matches(
  condition: RoleCondition,
  record: Record<string, unknown>,
  userId: string,
): boolean {
  return Object.entries(condition).every(([field, rule]) => {
    const value = record[field]
    if (rule.self) return String(value) === userId
    if (rule.eq !== undefined) return String(value) === String(rule.eq)
    if (rule.in) return rule.in.map(String).includes(String(value))
    // A rule that says nothing is not a rule that says yes to everything by
    // accident — but there is nothing here to test it against either.
    return true
  })
}
