import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { NodeDb } from '#/db'
import * as schema from '#/db/schema'
import { events } from '#/db/schema'
import type { NodeEnv } from '../env'
import { boundsOf, meter } from '../meter'
import { PRICE_LIST, creditsFor, meterItem, periodOf } from '#/lib/price-list'

/**
 * The meter.
 *
 * The claim being tested is the one the whole design rests on: counted usage is
 * *derived* from the event log rather than accumulated as it happens, so
 * metering a month twice gives the same answer, and metering a month that has
 * already passed gives the right one. Everything else about this pipeline —
 * no idempotency keys, replace-don't-add on master, retries being free — is a
 * consequence of that, and stops being true the moment it does not hold.
 */

const MIGRATIONS = join(import.meta.dir, '../../../drizzle')

function freshDb(): { db: NodeDb; raw: Database } {
  const raw = new Database(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(MIGRATIONS, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      try {
        if (statement.trim()) raw.run(statement.trim())
      } catch {
        /* empty */
      }
    }
  }
  return { db: drizzle(raw, { schema }) as unknown as NodeDb, raw }
}

/** No bucket and no master: this is the meter on its own. */
const env = { MEDIA: undefined, MASTER: undefined } as unknown as NodeEnv

let db: NodeDb
let raw: Database

beforeEach(() => {
  const made = freshDb()
  db = made.db
  raw = made.raw
})

afterEach(() => raw.close())

async function log(name: string, at: Date, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await db.insert(events).values({ name, createdAt: at, detail: {} })
  }
}

const lineFor = (reading: Awaited<ReturnType<typeof meter>>, item: string) =>
  reading.lines.find((line) => line.item === item)!

describe('counting a period', () => {
  test('events in the period are counted and priced', async () => {
    await log('submission.created', new Date('2026-04-10T12:00:00Z'), 3)
    await log('order.paid', new Date('2026-04-20T12:00:00Z'), 2)

    const reading = await meter(env, db, '2026-04')
    expect(lineFor(reading, 'submission').quantity).toBe(3)
    expect(lineFor(reading, 'submission').credits).toBe(3)
    // Orders cost five each.
    expect(lineFor(reading, 'order').quantity).toBe(2)
    expect(lineFor(reading, 'order').credits).toBe(10)
    expect(reading.credits).toBe(13)
  })

  test('events outside the period are not', async () => {
    await log('submission.created', new Date('2026-03-31T23:59:59Z'))
    await log('submission.created', new Date('2026-05-01T00:00:00Z'))
    const reading = await meter(env, db, '2026-04')
    expect(lineFor(reading, 'submission').quantity).toBe(0)
  })

  test('the boundary belongs to exactly one month', async () => {
    // The first instant of May is May's. Counted with `<=` at the top it would
    // land in April as well — one row a month, in the platform's favour, and
    // invisible unless somebody logs an event on the stroke of midnight.
    const boundary = new Date('2026-05-01T00:00:00.000Z')
    await log('submission.created', boundary)
    expect(lineFor(await meter(env, db, '2026-04'), 'submission').quantity).toBe(0)
    expect(lineFor(await meter(env, db, '2026-05'), 'submission').quantity).toBe(1)
  })

  test('metering the same period twice gives the same answer', async () => {
    // This is the property everything else depends on. If a second reading
    // differed, master replacing a period would silently change a bill and
    // master adding one would double it — there is no storage strategy that
    // survives a meter that is not repeatable.
    await log('submission.created', new Date('2026-04-10T12:00:00Z'), 4)
    await log('booking.confirmed', new Date('2026-04-11T12:00:00Z'), 2)

    const first = await meter(env, db, '2026-04')
    const second = await meter(env, db, '2026-04')
    expect(second.credits).toBe(first.credits)
    expect(second.lines.map((line) => [line.item, line.quantity])).toEqual(
      first.lines.map((line) => [line.item, line.quantity]),
    )
  })

  test('a month that has already passed can still be metered', async () => {
    // The reason M0 was worth shipping before anything read it. A meter built
    // today prices a January that nobody was metering at the time.
    await log('order.paid', new Date('2026-01-15T09:00:00Z'), 7)
    const reading = await meter(env, db, '2026-01')
    expect(lineFor(reading, 'order').quantity).toBe(7)
    expect(lineFor(reading, 'order').credits).toBe(35)
  })

  test('an event nothing prices costs nothing', async () => {
    // `resource.updated` is in the event catalog and not in the price list. It
    // must not quietly fall into some other item's count.
    await log('resource.updated', new Date('2026-04-10T12:00:00Z'), 50)
    const reading = await meter(env, db, '2026-04')
    expect(reading.credits).toBe(0)
  })

  test('what is not measured is reported as not measured', async () => {
    const reading = await meter(env, db, '2026-04')
    const egress = lineFor(reading, 'egress')
    expect(egress.quantity).toBe(0)
    // The flag is the whole point: a zero meaning "nobody counted" must be
    // distinguishable from a zero meaning "none used".
    expect(egress.pending).toBe(true)
    expect(lineFor(reading, 'submission').pending).toBeUndefined()
  })

  test('every price-list item appears, used or not', async () => {
    const reading = await meter(env, db, '2026-04')
    expect(reading.lines.map((line) => line.item).sort()).toEqual(
      PRICE_LIST.map((item) => item.key).sort(),
    )
  })
})

describe('periods and prices', () => {
  test('a period is the UTC month', () => {
    expect(periodOf(new Date('2026-04-10T12:00:00Z'))).toBe('2026-04')
    // 23:30 on the 31st in a zone behind UTC is already the next month in UTC,
    // and the meter is a UTC thing throughout so that two nodes in different
    // countries cut their months at the same instant.
    expect(periodOf(new Date('2026-04-30T23:30:00Z'))).toBe('2026-04')
    expect(periodOf(new Date('2026-05-01T00:30:00Z'))).toBe('2026-05')
  })

  test('bounds are the first instant of the month and of the next', () => {
    const { from, to } = boundsOf('2026-12')
    expect(from.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(to.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  test('a fraction of a unit costs a whole credit', () => {
    // Storage is 40 credits a gigabyte. Rounding down would make every partial
    // gigabyte free, which on a node with 100 MB of files means storage is
    // free forever. A credit is small enough that rounding up one is not a
    // meaningful overcharge — the opposite of a marketplace commission, where
    // the same rounding would be taken on every sale.
    const storage = meterItem('storage')!
    expect(creditsFor(storage, 1_073_741_824)).toBe(40)
    expect(creditsFor(storage, 1)).toBe(1)
    expect(creditsFor(storage, 0)).toBe(0)
  })
})
