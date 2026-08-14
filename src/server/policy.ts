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
   * permission -> groups of conditions.
   *
   * Every group must be satisfied, and any one condition within a group will
   * satisfy it: *all of these, each in any of these ways*. An empty list of
   * groups means allowed with no narrowing at all.
   *
   * Groups exist because a grant can be narrowed twice by two different
   * authorities. A role says which forms a person may read; a key that person
   * minted says which of those the agent holding it may read. Both have to
   * hold, and neither may widen the other — so each contributes a group, and
   * the answer is their conjunction. Flattening them into one list would read
   * as *either*, which is the whole footgun this shape exists to avoid.
   */
  allow: Record<string, Array<Array<RoleCondition>>>
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

  // One authority, so one group each. `intersect` is what puts two together.
  const grouped: Record<string, Array<Array<RoleCondition>>> = {}
  for (const [permission, ways] of Object.entries(allow)) {
    grouped[permission] = ways.length ? [ways] : []
  }

  return {
    permissions: Object.keys(grouped),
    allow: grouped,
    deny,
  }
}

/**
 * Both gates, and only what passes both.
 *
 * A key belongs to an account and can never reach past it, however generously
 * it is written — so this is an intersection and not a merge. A permission
 * survives only if both sides hold it. A record is reachable only if it
 * satisfies both sides' narrowing, which is why the groups are concatenated
 * rather than combined: two groups mean two things that must both be true.
 *
 * Denials from either side are kept. A refusal is a refusal whoever wrote it.
 */
export function intersect(outer: Grant, inner: Grant): Grant {
  const permissions = outer.permissions.filter((key) =>
    inner.permissions.includes(key),
  )

  const allow: Record<string, Array<Array<RoleCondition>>> = {}
  const deny: Record<string, Array<RoleCondition>> = {}

  for (const permission of permissions) {
    allow[permission] = [
      ...(outer.allow[permission] ?? []),
      ...(inner.allow[permission] ?? []),
    ]
    const refusals = [
      ...(outer.deny[permission] ?? []),
      ...(inner.deny[permission] ?? []),
    ]
    if (refusals.length) deny[permission] = refusals
  }

  return { permissions, allow, deny }
}

/**
 * Whether one record falls inside a grant.
 *
 * The same arithmetic the WHERE clause does, applied to a single row — used on
 * writes, where there is no query to narrow and the record has to be checked
 * against the rule directly. A condition that only filtered lists would be a
 * display preference rather than a permission.
 */
export interface Asker {
  userId: string
  /** vendors this account acts for; empty for everyone who is not one */
  vendorIds: Array<number>
}

/** Accepts a bare user id for the many callers that have no vendor question. */
function askerOf(who: Asker | string): Asker {
  return typeof who === 'string' ? { userId: who, vendorIds: [] } : who
}

export function grantAllows(
  grant: Grant,
  permission: string,
  record: Record<string, unknown>,
  who: Asker | string,
): boolean {
  const userId = who
  if (!grant.permissions.includes(permission)) return false

  // Every group, each satisfied by any one of its conditions.
  const asker = askerOf(userId)
  const groups = grant.allow[permission] ?? []
  const allowed = groups.every((group) =>
    group.some((way) => matches(way, record, asker)),
  )
  if (!allowed) return false

  const refusals = grant.deny[permission] ?? []
  return !refusals.some((refusal) => matches(refusal, record, asker))
}

/** Whether a record satisfies every field of one condition. */
export function matches(
  condition: RoleCondition,
  record: Record<string, unknown>,
  who: Asker | string,
): boolean {
  const asker = askerOf(who)
  return Object.entries(condition).every(([field, rule]) => {
    const value = record[field]
    // Resolved against the asker rather than written down, so one rule serves
    // everybody who holds it.
    if (rule.mine) {
      return (
        value !== null &&
        value !== undefined &&
        asker.vendorIds.includes(Number(value))
      )
    }
    if (rule.self) return String(value) === asker.userId
    if (rule.eq !== undefined) return String(value) === String(rule.eq)
    if (rule.in) return rule.in.map(String).includes(String(value))
    // A rule that says nothing is not a rule that says yes to everything by
    // accident — but there is nothing here to test it against either.
    return true
  })
}
