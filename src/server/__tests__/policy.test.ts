import { describe, expect, test } from 'bun:test'

import { EMPTY_GRANT, evaluate, grantAllows, intersect } from '../policy'
import type { RoleCondition } from '#/db/schema'
import type { PolicyInput } from '../policy'

/**
 * The permission arithmetic, checked directly.
 *
 * These are the cases where being wrong is expensive and being wrong is quiet:
 * a narrowed grant that widens, a denial that a later grant undoes, a role that
 * reaches one desk reaching two. None of them look like failures from the panel
 * — the screen just shows more rows than it should.
 */

const AVAILABLE = [
  'forms:read',
  'submissions:read',
  'submissions:write',
  'submissions:delete',
]

const bare = {
  permissions: [] as Array<string>,
  conditions: {} as Record<string, never>,
  policies: [] as Array<PolicyInput>,
  available: AVAILABLE,
}

const policy = (over: Partial<PolicyInput>): PolicyInput => ({
  key: 'p',
  effect: 'allow',
  permissions: [],
  condition: {},
  ...over,
})

describe('allows', () => {
  test('an unnarrowed grant narrows nothing', () => {
    const grant = evaluate({ ...bare, permissions: ['forms:read'] })
    expect(grant.permissions).toEqual(['forms:read'])
    expect(grant.allow['forms:read']).toEqual([])
    expect(grantAllows(grant, 'forms:read', { id: 9 }, 'u1')).toBe(true)
  })

  test('a narrowed grant stays narrowed', () => {
    const grant = evaluate({
      ...bare,
      permissions: ['submissions:read'],
      conditions: { 'submissions:read': { formId: { in: [3] } } },
    })
    expect(grant.allow['submissions:read']).toEqual([[{ formId: { in: [3] } }]])
    expect(grantAllows(grant, 'submissions:read', { formId: 3 }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { formId: 4 }, 'u1')).toBe(false)
  })

  test('two narrowed grants reach either, not the overlap', () => {
    const grant = evaluate({
      ...bare,
      policies: [
        policy({
          key: 'desk-a',
          permissions: ['submissions:read'],
          condition: { formId: { in: [1] } },
        }),
        policy({
          key: 'desk-b',
          permissions: ['submissions:read'],
          condition: { formId: { in: [2] } },
        }),
      ],
    })
    expect(grantAllows(grant, 'submissions:read', { formId: 1 }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { formId: 2 }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { formId: 3 }, 'u1')).toBe(false)
  })

  test('an unnarrowed grant beside a narrowed one wins', () => {
    const grant = evaluate({
      ...bare,
      permissions: ['submissions:read'],
      conditions: { 'submissions:read': { formId: { in: [1] } } },
      policies: [policy({ permissions: ['submissions:read'] })],
    })
    expect(grant.allow['submissions:read']).toEqual([])
    expect(grantAllows(grant, 'submissions:read', { formId: 99 }, 'u1')).toBe(true)
  })

  test('order does not decide the answer', () => {
    const wide = policy({ key: 'wide', permissions: ['submissions:read'] })
    const narrow = policy({
      key: 'narrow',
      permissions: ['submissions:read'],
      condition: { formId: { in: [1] } },
    })
    const a = evaluate({ ...bare, policies: [wide, narrow] })
    const b = evaluate({ ...bare, policies: [narrow, wide] })
    expect(a.allow).toEqual(b.allow)
  })

  test('self resolves against the asker', () => {
    const grant = evaluate({
      ...bare,
      permissions: ['submissions:read'],
      conditions: { 'submissions:read': { userId: { self: true } } },
    })
    expect(grantAllows(grant, 'submissions:read', { userId: 'u1' }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { userId: 'u2' }, 'u1')).toBe(false)
  })

  test('a permission the node does not offer is not granted', () => {
    const grant = evaluate({ ...bare, permissions: ['team:manage'] })
    expect(grant.permissions).toEqual([])
  })
})

describe('denies', () => {
  test('an unconditional deny removes the permission outright', () => {
    const grant = evaluate({
      ...bare,
      permissions: ['submissions:delete'],
      policies: [policy({ effect: 'deny', permissions: ['submissions:delete'] })],
    })
    expect(grant.permissions).not.toContain('submissions:delete')
    expect(grantAllows(grant, 'submissions:delete', {}, 'u1')).toBe(false)
  })

  test('a deny beats an allow attached after it', () => {
    const grant = evaluate({
      ...bare,
      policies: [
        policy({ key: 'no', effect: 'deny', permissions: ['submissions:delete'] }),
        policy({ key: 'yes', permissions: ['submissions:delete'] }),
      ],
    })
    expect(grant.permissions).not.toContain('submissions:delete')
  })

  test('a conditional deny carves a hole in a wider allow', () => {
    const grant = evaluate({
      ...bare,
      permissions: ['submissions:read'],
      policies: [
        policy({
          effect: 'deny',
          permissions: ['submissions:read'],
          condition: { formId: { in: [7] } },
        }),
      ],
    })
    expect(grantAllows(grant, 'submissions:read', { formId: 6 }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { formId: 7 }, 'u1')).toBe(false)
  })

  test('a deny reaches a record an allow specifically named', () => {
    const grant = evaluate({
      ...bare,
      policies: [
        policy({
          key: 'yes',
          permissions: ['submissions:read'],
          condition: { formId: { in: [7] } },
        }),
        policy({
          key: 'no',
          effect: 'deny',
          permissions: ['submissions:read'],
          condition: { formId: { in: [7] } },
        }),
      ],
    })
    expect(grantAllows(grant, 'submissions:read', { formId: 7 }, 'u1')).toBe(false)
  })
})

describe('wildcards', () => {
  test('* covers what the node offers, and only that', () => {
    const grant = evaluate({
      ...bare,
      policies: [policy({ permissions: ['*'] })],
    })
    expect(grant.permissions.sort()).toEqual([...AVAILABLE].sort())
  })

  test('* denies everything, including grants beside it', () => {
    const grant = evaluate({
      ...bare,
      permissions: ['forms:read', 'submissions:read'],
      policies: [policy({ effect: 'deny', permissions: ['*'] })],
    })
    expect(grant.permissions).toEqual([])
  })

  test('a feature switched off narrows a wildcard too', () => {
    const grant = evaluate({
      ...bare,
      available: ['forms:read'],
      policies: [policy({ permissions: ['*'] })],
    })
    expect(grant.permissions).toEqual(['forms:read'])
  })
})

describe('nothing at all', () => {
  test('an empty grant refuses everything', () => {
    expect(grantAllows(EMPTY_GRANT, 'forms:read', {}, 'u1')).toBe(false)
  })

  test('a role with no grant and no policies holds nothing', () => {
    expect(evaluate(bare).permissions).toEqual([])
  })
})

/**
 * The second gate.
 *
 * A key belongs to an account, and the person who minted it may narrow it
 * further before handing it to an agent. Both rules have to hold. The failure
 * that matters here is not an error — it is a key that quietly does more than
 * the person who minted it chose, or more than their own account may.
 */
describe('two gates', () => {
  const role = (
    permissions: Array<string>,
    conditions: Record<string, RoleCondition> = {},
  ) => evaluate({ ...bare, permissions, conditions })

  const key = (
    permissions: Array<string>,
    conditions: Record<string, RoleCondition> = {},
  ) => evaluate({ ...bare, permissions, conditions })

  test('a key cannot hold what the account does not', () => {
    const grant = intersect(role(['forms:read']), key(AVAILABLE))
    expect(grant.permissions).toEqual(['forms:read'])
  })

  test('a key can hold less than the account does', () => {
    const grant = intersect(role(AVAILABLE), key(['forms:read']))
    expect(grant.permissions).toEqual(['forms:read'])
  })

  test('both narrowings apply, and neither widens the other', () => {
    const grant = intersect(
      role(['submissions:read'], {
        'submissions:read': { formId: { in: [1, 2] } },
      }),
      key(['submissions:read'], {
        'submissions:read': { formId: { in: [2, 3] } },
      }),
    )
    // Only the form both sides allow.
    expect(grantAllows(grant, 'submissions:read', { formId: 2 }, 'u1')).toBe(true)
    // The account allows it; the key does not.
    expect(grantAllows(grant, 'submissions:read', { formId: 1 }, 'u1')).toBe(false)
    // The key allows it; the account does not. This is the escalation case.
    expect(grantAllows(grant, 'submissions:read', { formId: 3 }, 'u1')).toBe(false)
    expect(grantAllows(grant, 'submissions:read', { formId: 9 }, 'u1')).toBe(false)
  })

  test('an unnarrowed key does not widen a narrowed account', () => {
    const grant = intersect(
      role(['submissions:read'], {
        'submissions:read': { formId: { in: [1] } },
      }),
      key(['submissions:read']),
    )
    expect(grantAllows(grant, 'submissions:read', { formId: 1 }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { formId: 2 }, 'u1')).toBe(false)
  })

  test('an unnarrowed account does not widen a narrowed key', () => {
    const grant = intersect(
      role(['submissions:read']),
      key(['submissions:read'], {
        'submissions:read': { formId: { in: [1] } },
      }),
    )
    expect(grantAllows(grant, 'submissions:read', { formId: 1 }, 'u1')).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { formId: 2 }, 'u1')).toBe(false)
  })

  test('two groups are kept as two, not flattened into alternatives', () => {
    const grant = intersect(
      role(['submissions:read'], {
        'submissions:read': { formId: { in: [1] } },
      }),
      key(['submissions:read'], {
        'submissions:read': { formId: { in: [2] } },
      }),
    )
    // Flattened, this would read as "form 1 or form 2" and allow both.
    expect(grant.allow['submissions:read']).toHaveLength(2)
    expect(grantAllows(grant, 'submissions:read', { formId: 1 }, 'u1')).toBe(false)
    expect(grantAllows(grant, 'submissions:read', { formId: 2 }, 'u1')).toBe(false)
  })

  test('a denial on either side is kept', () => {
    const withDeny = evaluate({
      ...bare,
      permissions: ['submissions:read'],
      policies: [
        policy({
          effect: 'deny',
          permissions: ['submissions:read'],
          condition: { formId: { in: [7] } },
        }),
      ],
    })
    const fromKey = intersect(role(['submissions:read']), withDeny)
    expect(grantAllows(fromKey, 'submissions:read', { formId: 7 }, 'u1')).toBe(false)
    expect(grantAllows(fromKey, 'submissions:read', { formId: 6 }, 'u1')).toBe(true)

    const fromAccount = intersect(withDeny, role(['submissions:read']))
    expect(grantAllows(fromAccount, 'submissions:read', { formId: 7 }, 'u1')).toBe(false)
  })

  test('a key scoped to nothing reaches nothing', () => {
    const grant = intersect(role(AVAILABLE), key([]))
    expect(grant.permissions).toEqual([])
    expect(grantAllows(grant, 'forms:read', {}, 'u1')).toBe(false)
  })
})

/**
 * Vendor ownership.
 *
 * The rule that makes a marketplace one role instead of forty. `mine` resolves
 * against the vendors the asking account acts for, so the same policy serves
 * every vendor — and the failure that matters is one vendor reading another's
 * rows, which looks like nothing at all from the screen.
 */
describe('own vendor', () => {
  const scoped = (field: string) =>
    evaluate({
      ...bare,
      available: ['submissions:read'],
      permissions: ['submissions:read'],
      conditions: { 'submissions:read': { [field]: { mine: true } } },
    })

  const acting = (...vendorIds: Array<number>) => ({ userId: 'u1', vendorIds })

  test('reaches a row belonging to a vendor they act for', () => {
    expect(
      grantAllows(scoped('vendorId'), 'submissions:read', { vendorId: 7 }, acting(7)),
    ).toBe(true)
  })

  test('does not reach another vendor’s row', () => {
    expect(
      grantAllows(scoped('vendorId'), 'submissions:read', { vendorId: 8 }, acting(7)),
    ).toBe(false)
  })

  test('reaches every vendor they act for, and no more', () => {
    const grant = scoped('vendorId')
    expect(grantAllows(grant, 'submissions:read', { vendorId: 7 }, acting(7, 9))).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { vendorId: 9 }, acting(7, 9))).toBe(true)
    expect(grantAllows(grant, 'submissions:read', { vendorId: 8 }, acting(7, 9))).toBe(false)
  })

  test('an account acting for nobody reaches nothing', () => {
    expect(
      grantAllows(scoped('vendorId'), 'submissions:read', { vendorId: 7 }, acting()),
    ).toBe(false)
  })

  test('a row belonging to no vendor is not everybody’s', () => {
    // The unowned row is the one that quietly appears in every vendor's list if
    // null is treated as a match.
    const grant = scoped('vendorId')
    expect(grantAllows(grant, 'submissions:read', { vendorId: null }, acting(7))).toBe(false)
    expect(grantAllows(grant, 'submissions:read', {}, acting(7))).toBe(false)
  })

  test('a string id from the wire still matches', () => {
    expect(
      grantAllows(scoped('vendorId'), 'submissions:read', { vendorId: '7' }, acting(7)),
    ).toBe(true)
  })

  test('a bare user id means no vendors, not all of them', () => {
    // Every existing caller passes a plain string. None of them may
    // accidentally satisfy a vendor rule.
    expect(
      grantAllows(scoped('vendorId'), 'submissions:read', { vendorId: 7 }, 'u1'),
    ).toBe(false)
  })

  test('a key scoped to one vendor cannot reach the account’s other', () => {
    // Both gates again, with the vendor rule on one side: the account acts for
    // 7 and 9, the key it minted names only 7.
    const account = scoped('vendorId')
    const key = evaluate({
      ...bare,
      available: ['submissions:read'],
      permissions: ['submissions:read'],
      conditions: { 'submissions:read': { vendorId: { in: [7] } } },
    })
    const both = intersect(account, key)
    expect(grantAllows(both, 'submissions:read', { vendorId: 7 }, acting(7, 9))).toBe(true)
    expect(grantAllows(both, 'submissions:read', { vendorId: 9 }, acting(7, 9))).toBe(false)
  })
})
