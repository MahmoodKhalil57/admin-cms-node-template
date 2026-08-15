import { describe, expect, test } from 'bun:test'

import { BUILTIN_ROLES } from '../team'
import { PERMISSION_CATALOG } from '#/lib/permission-catalog'

/**
 * What the roles a node ships with may and may not reach.
 *
 * Most of a starter role is a suggestion — a business that wants its designer
 * to handle enquiries only has to tick a box. These tests are for the few
 * properties that are not suggestions, where the absence of a permission is the
 * reason the role exists at all.
 */

const roleFor = (key: string) => BUILTIN_ROLES.find((role) => role.key === key)!

describe('collaborator', () => {
  test('can build projects', () => {
    expect(roleFor('collaborator').permissions).toContain('projects:create')
  })

  test('cannot choose whose infrastructure they are built on', () => {
    /*
      The one that matters. Layer-3 projects land on the *operator's* own
      Cloudflare and GitHub accounts, and `infra:connect` is what decides which
      accounts those are. A collaborator holding it could repoint the
      connection at their own and walk off with the operator's platform.

      Building on somebody's infrastructure and choosing whose it is are
      different jobs. This role is only the first.
    */
    expect(roleFor('collaborator').permissions).not.toContain('infra:connect')
  })

  test('cannot hand their access to anybody', () => {
    // Without this a collaborator could grant themselves everything above,
    // which would make every other absence here decorative.
    expect(roleFor('collaborator').permissions).not.toContain('team:manage')
  })

  test('is brought in to build, not to run the place', () => {
    const held = roleFor('collaborator').permissions ?? []
    for (const forbidden of [
      'content:write',
      'submissions:read',
      'settings:write',
      'features:manage',
      'payments:configure',
      'vendors:manage',
    ]) {
      expect(held).not.toContain(forbidden)
    }
  })

  test('only reaches its own projects', () => {
    // Two collaborators on one node work side by side, and neither can remove
    // the other's work.
    const conditions = (roleFor('collaborator').conditions ?? {}) as Record<
      string,
      unknown
    >
    expect(conditions['projects:destroy']).toEqual({ ownerUserId: { self: true } })
  })
})

describe('every starter role', () => {
  test('names only permissions that exist', () => {
    // A role granting a permission nothing checks is a role that quietly does
    // less than it says — and a typo is indistinguishable from a decision.
    const known = new Set(PERMISSION_CATALOG.map((entry) => entry.key))
    for (const role of BUILTIN_ROLES) {
      for (const permission of role.permissions ?? []) {
        expect({ role: role.key, permission, known: known.has(permission) }).toEqual({
          role: role.key,
          permission,
          known: true,
        })
      }
    }
  })

  test('conditions only narrow permissions the role holds', () => {
    // A condition on a permission somebody does not hold narrows nothing, and
    // reads on the roles screen as a restriction that is doing work.
    for (const role of BUILTIN_ROLES) {
      const held = new Set(role.permissions ?? [])
      for (const permission of Object.keys(role.conditions ?? {})) {
        expect({ role: role.key, permission, held: held.has(permission) }).toEqual({
          role: role.key,
          permission,
          held: true,
        })
      }
    }
  })
})
