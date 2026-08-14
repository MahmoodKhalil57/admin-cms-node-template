import { describe, expect, test } from 'bun:test'

import { changedKeys, mayTouch, refusedFields, subjectFor } from '../cms-proxy'
import type { Subject } from '../cms-proxy'
import { evaluate } from '../policy'
import type { Principal } from '../authz'
import type { StaticCollection } from '../sveltia'

/**
 * The rule that decides what a designer may change on the site.
 *
 * Worth testing away from the network, because the failure that matters is not
 * an error — it is a save that goes through when it should not have. Every case
 * here is one somebody would only notice by reading the repository's history
 * afterwards.
 */

const COLLECTIONS = [
  {
    name: 'pages',
    label: 'Pages',
    kind: 'folder',
    folder: 'content/pages',
    extension: 'json',
    canCreate: true,
    canDelete: true,
  },
  {
    name: 'settings',
    label: 'Settings',
    kind: 'files',
    extension: 'json',
    canCreate: false,
    canDelete: false,
    files: [
      { name: 'site', label: 'Site', file: 'content/site.json', fields: [] },
      {
        name: 'catalog',
        label: 'Catalog',
        file: 'content/catalog.json',
        fields: [],
      },
    ],
  },
] as unknown as Array<StaticCollection>

const AVAILABLE = ['content:read', 'content:write']

function designer(
  permissions: Array<string>,
  conditions: Record<string, Record<string, never>> | object = {},
  policies: Array<{
    key: string
    effect: string
    permissions: Array<string>
    condition: Record<string, unknown>
  }> = [],
): Principal {
  const grant = evaluate({
    permissions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions: conditions as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    policies: policies as any,
    available: AVAILABLE,
  })
  return {
    userId: 'u1',
    email: 'designer@example.com',
    name: 'Designer',
    isOwner: false,
    viaKey: false,
    vendorIds: [],
    roleKey: 'designer',
    permissions: grant.permissions,
    grant,
  }
}

const owner: Principal = {
  ...designer(AVAILABLE),
  isOwner: true,
  roleKey: 'rootAdmin',
}

describe('what a path is', () => {
  test('a file in a folder collection is that collection and that entry', () => {
    expect(subjectFor(COLLECTIONS, 'content/pages/about.json')).toEqual({
      collection: 'pages',
      file: 'about',
      path: 'content/pages/about.json',
    })
  })

  test('a named singleton is its own entry, not its path', () => {
    expect(subjectFor(COLLECTIONS, 'content/site.json')).toEqual({
      collection: 'settings',
      file: 'site',
      path: 'content/site.json',
    })
  })

  test('a leading slash does not make it a different file', () => {
    expect(subjectFor(COLLECTIONS, '/content/site.json').file).toBe('site')
  })

  test('a path no collection claims belongs to none', () => {
    expect(subjectFor(COLLECTIONS, 'index.html').collection).toBeNull()
  })

  test('a folder prefix does not swallow a sibling directory', () => {
    // `content/pages-archive/` starts with `content/pages` as a string but is
    // not inside it, and treating it as `pages` would grant access to it.
    expect(
      subjectFor(COLLECTIONS, 'content/pages-archive/old.json').collection,
    ).toBeNull()
  })
})

describe('collections', () => {
  const pages: Subject = {
    collection: 'pages',
    file: 'about',
    path: 'content/pages/about.json',
  }
  const site: Subject = {
    collection: 'settings',
    file: 'site',
    path: 'content/site.json',
  }

  test('an unnarrowed grant reaches every collection', () => {
    const who = designer(['content:write'])
    expect(mayTouch(who, pages, true)).toBe(true)
    expect(mayTouch(who, site, true)).toBe(true)
  })

  test('a grant narrowed to pages does not reach the settings', () => {
    const who = designer(['content:write'], {
      'content:write': { collection: { in: ['pages'] } },
    })
    expect(mayTouch(who, pages, true)).toBe(true)
    expect(mayTouch(who, site, true)).toBe(false)
  })

  test('a deny policy carves one singleton out of a whole grant', () => {
    const who = designer(['content:write'], {}, [
      {
        key: 'not-the-settings',
        effect: 'deny',
        permissions: ['content:write'],
        condition: { file: { in: ['site'] } },
      },
    ])
    expect(mayTouch(who, pages, true)).toBe(true)
    expect(mayTouch(who, site, true)).toBe(false)
    expect(
      mayTouch(
        who,
        { collection: 'settings', file: 'catalog', path: 'content/catalog.json' },
        true,
      ),
    ).toBe(true)
  })

  test('no write permission means no write, however narrow the rule', () => {
    const who = designer(['content:read'])
    expect(mayTouch(who, pages, true)).toBe(false)
    expect(mayTouch(who, pages, false)).toBe(true)
  })

  test('a path outside every collection can be read but never written', () => {
    const who = designer(['content:read', 'content:write'])
    const stray: Subject = { collection: null, file: null, path: 'index.html' }
    expect(mayTouch(who, stray, false)).toBe(true)
    expect(mayTouch(who, stray, true)).toBe(false)
  })

  test('the owner is outside the rule', () => {
    const stray: Subject = { collection: null, file: null, path: 'index.html' }
    expect(mayTouch(owner, stray, true)).toBe(true)
  })
})

describe('fields', () => {
  const site: Subject = {
    collection: 'settings',
    file: 'site',
    path: 'content/site.json',
  }

  const restricted = () =>
    designer(['content:write'], {}, [
      {
        key: 'not-the-backend',
        effect: 'deny',
        permissions: ['content:write'],
        condition: { field: { in: ['backend'] } },
      },
    ])

  test('an untouched restricted field is not an attempt', () => {
    const before = { announcement: 'Open', backend: { url: 'https://a' } }
    const after = { announcement: 'Closed', backend: { url: 'https://a' } }
    expect(refusedFields(restricted(), site, before, after)).toEqual([])
  })

  test('changing a restricted field is refused', () => {
    const before = { announcement: 'Open', backend: { url: 'https://a' } }
    const after = { announcement: 'Open', backend: { url: 'https://evil' } }
    expect(refusedFields(restricted(), site, before, after)).toEqual(['backend'])
  })

  test('removing a restricted field is changing it', () => {
    const before = { announcement: 'Open', backend: { url: 'https://a' } }
    const after = { announcement: 'Open' }
    expect(refusedFields(restricted(), site, before, after)).toEqual(['backend'])
  })

  test('adding one is too', () => {
    expect(
      refusedFields(restricted(), site, { announcement: 'Open' }, {
        announcement: 'Open',
        backend: { url: 'https://evil' },
      }),
    ).toEqual(['backend'])
  })

  test('the owner is outside this too', () => {
    expect(
      refusedFields(owner, site, { backend: 1 }, { backend: 2 }),
    ).toEqual([])
  })
})

describe('what changed', () => {
  test('order inside a value is not a change', () => {
    expect(changedKeys({ a: { x: 1 } }, { a: { x: 1 } })).toEqual([])
  })

  test('a nested difference shows as its top-level key', () => {
    expect(changedKeys({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(['a'])
  })

  test('a non-object document has no fields to compare', () => {
    expect(changedKeys(null, [1, 2, 3])).toEqual([])
  })
})
