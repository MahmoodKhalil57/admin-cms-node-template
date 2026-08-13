import { describe, expect, test } from 'bun:test'

import { EMPTY_GRANT, evaluate, grantAllows } from '../policy'
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
    expect(grant.allow['submissions:read']).toEqual([{ formId: { in: [3] } }])
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
