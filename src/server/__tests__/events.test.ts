import { describe, expect, test } from 'bun:test'

import { EVENT_CATALOG, eventDefinition, record } from '../events'
import { EMPTY_GRANT } from '../policy'
import type { Principal } from '../authz'

/**
 * The two promises the event log makes.
 *
 * That it never breaks what it records — an enquiry that is not logged is a gap
 * in a report, and an enquiry refused because logging failed is a lost
 * customer. And that what it wrote stays written.
 */

const person: Principal = {
  userId: 'u1',
  email: 'someone@example.com',
  name: 'Someone',
  isOwner: false,
  viaKey: false,
  vendorIds: [],
  roleKey: 'operator',
  permissions: [],
  grant: EMPTY_GRANT,
}

/** A database that fails the way a real one does under load. */
const brokenDb = {
  insert() {
    throw new Error('database is unavailable')
  },
} as never

/** One that accepts the write and remembers it. */
function workingDb() {
  const written: Array<Record<string, unknown>> = []
  return {
    written,
    db: {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          written.push(row)
        },
      }),
    } as never,
  }
}

describe('recording', () => {
  test('a database failure never reaches the caller', async () => {
    // No rejects(), on purpose: the promise must resolve.
    await expect(
      record(brokenDb, { name: 'submission.created' }),
    ).resolves.toBeUndefined()
  })

  test('an actor is recorded as an id, not an object', async () => {
    const { db, written } = workingDb()
    await record(db, {
      name: 'submission.created',
      actor: person,
      subjectType: 'submissions',
      subjectId: 12,
    })
    expect(written[0]).toMatchObject({
      name: 'submission.created',
      actorUserId: 'u1',
      viaKey: false,
      subjectType: 'submissions',
      // Stringified, because a subject id may be a slug or a number and the
      // column has to hold both.
      subjectId: '12',
    })
  })

  test('an anonymous visitor is recorded without an actor', async () => {
    const { db, written } = workingDb()
    await record(db, { name: 'submission.created' })
    expect(written[0]!.actorUserId).toBeNull()
    expect(written[0]!.vendorId).toBeNull()
  })

  test('a key is marked as one', async () => {
    const { db, written } = workingDb()
    await record(db, { name: 'resource.created', actor: { ...person, viaKey: true } })
    expect(written[0]!.viaKey).toBe(true)
  })

  test('a subject id of zero is kept rather than dropped', async () => {
    const { db, written } = workingDb()
    await record(db, { name: 'resource.created', subjectId: 0 })
    expect(written[0]!.subjectId).toBe('0')
  })
})

describe('the catalog', () => {
  test('every name is unique', () => {
    const keys = EVENT_CATALOG.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('names read as subject.past-tense', () => {
    for (const entry of EVENT_CATALOG) {
      // A compound verb keeps its underscore — `vendor.member_added` says what
      // happened more precisely than any single word would.
      expect(entry.key).toMatch(/^[a-z]+\.[a-z]+(_[a-z]+)*$/)
    }
  })

  test('the automation trigger and the event are spelled the same', () => {
    // Both describe the same moment. Two spellings would mean a dashboard and
    // a notification disagreeing about what happened.
    expect(eventDefinition('submission.created')).toBeDefined()
  })
})
