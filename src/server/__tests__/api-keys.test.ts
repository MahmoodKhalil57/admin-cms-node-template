import { describe, expect, test } from 'bun:test'

import { KeyMintRefused, mintKey } from '../api-keys'
import { EMPTY_GRANT } from '../policy'
import type { Principal } from '../authz'

/**
 * The depth of the chain, fixed at one.
 *
 * A key may narrow itself when it is made, which makes two gates. If a key
 * could mint another there would be a third, and a fourth, and every check
 * downstream would have to walk back through however many parents a key
 * happened to have. This is the test that keeps the number at two.
 *
 * It is worth pinning because the thing that would break it is a reasonable
 * change: letting people mint their own keys without `team:manage` is a
 * feature somebody will ask for, and today that permission is the only other
 * reason a key cannot get here.
 */

const person: Principal = {
  userId: 'u1',
  email: 'someone@example.com',
  name: 'Someone',
  isOwner: false,
  viaKey: false,
  roleKey: 'operator',
  permissions: [],
  grant: EMPTY_GRANT,
}

const key: Principal = { ...person, viaKey: true }

/** A database that would notice if anything reached it. */
const forbiddenDb = new Proxy(
  {},
  {
    get() {
      throw new Error('a refused mint must not touch the database')
    },
  },
) as never

describe('minting', () => {
  test('a key cannot mint another key', async () => {
    await expect(mintKey(forbiddenDb, key, 'u1', 'child')).rejects.toThrow(
      KeyMintRefused,
    )
  })

  test('the refusal happens before anything is written', async () => {
    // The proxy above throws on any property access, so reaching the insert at
    // all fails with a different error than the one expected here.
    await expect(mintKey(forbiddenDb, key, 'u1', 'child')).rejects.toThrow(
      'A key cannot mint another key.',
    )
  })

  test('a key belonging to the root admin cannot either', async () => {
    await expect(
      mintKey(forbiddenDb, { ...key, isOwner: true }, 'u1', 'child'),
    ).rejects.toThrow(KeyMintRefused)
  })

  test('a person at a browser reaches the database', async () => {
    // Not a successful mint — there is no database here — but it must get past
    // the guard and fail for a different reason.
    await expect(mintKey(forbiddenDb, person, 'u1', 'fine')).rejects.toThrow(
      'a refused mint must not touch the database',
    )
  })
})
