import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import * as schema from '#/db/schema'
import {
  availabilityExceptions,
  availabilityRules,
  bookingSlots,
  bookings,
  services,
} from '#/db/schema'
import { cancelBooking, expireHolds, holdSlot } from '../booking/hold'
import { slotsFor } from '../booking/slots'

/**
 * The diary, against a real database.
 *
 * These are the only tests here that use one, and it is not incidental: the
 * claim being tested is that the *database* refuses a double-booking, so a
 * fake that returns whatever it is told would test nothing at all. The schema
 * comes from the migrations rather than from a hand-written CREATE TABLE, so
 * the unique index under test is the one that will actually ship.
 */

const MIGRATIONS = join(import.meta.dir, '../../../drizzle')

function freshDb(): { db: NodeDb; raw: Database } {
  const raw = new Database(':memory:')
  raw.run('PRAGMA foreign_keys = ON')

  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (!trimmed) continue
      // Migrations that Drizzle wrote for D1 occasionally reference something
      // an in-memory database has no opinion about; a failure to apply one is
      // only a problem if a table this file needs is missing, and the tests
      // below say so plainly if it is.
      try {
        raw.run(trimmed)
      } catch {
        /* empty */
      }
    }
  }

  return { db: drizzle(raw, { schema }) as unknown as NodeDb, raw }
}

/** A Wednesday, well clear of any clock change. */
const WEDNESDAY = '2026-06-10'

async function seed(db: NodeDb, over: Partial<typeof services.$inferInsert> = {}) {
  await db.insert(availabilityRules).values({
    vendorId: null,
    // 09:00–17:00 UTC every weekday.
    weekday: 3,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    timezone: 'UTC',
  })
  const [service] = await db
    .insert(services)
    .values({
      slug: 'consult',
      name: 'Consultation',
      price: 5000,
      status: 'published',
      durationMinutes: 60,
      bufferMinutes: 0,
      leadMinutes: 0,
      horizonDays: 60,
      holdMinutes: 15,
      ...over,
    })
    .returning()
  return service!
}

/** Somewhere in the middle of the seeded Wednesday. */
const at = (hour: number, minute = 0) =>
  new Date(`${WEDNESDAY}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`)

/** Far enough before the Wednesday that nothing is filtered out as past. */
const NOW = new Date('2026-06-08T08:00:00.000Z')

let db: NodeDb
let raw: Database

beforeEach(() => {
  const made = freshDb()
  db = made.db
  raw = made.raw
})

afterEach(() => {
  raw.close()
})

describe('the slots on offer', () => {
  test('a day of availability becomes hourly slots', async () => {
    const service = await seed(db)
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      now: NOW,
    })
    // 09:00 to 17:00 in hour-long appointments is eight, the last starting at
    // 16:00 — an appointment that would end after closing is not on offer.
    expect(slots.length).toBe(8)
    expect(slots[0]!.startsAt).toBe('2026-06-10T09:00:00.000Z')
    expect(slots.at(-1)!.startsAt).toBe('2026-06-10T16:00:00.000Z')
  })

  test('the gap after an appointment is time nobody else gets', async () => {
    const service = await seed(db, { durationMinutes: 60, bufferMinutes: 30 })
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      now: NOW,
    })
    // 90 minutes each: 09:00, 10:30, 12:00, 13:30, 15:00. The 16:30 start
    // would run past closing.
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-06-10T09:00:00.000Z',
      '2026-06-10T10:30:00.000Z',
      '2026-06-10T12:00:00.000Z',
      '2026-06-10T13:30:00.000Z',
      '2026-06-10T15:00:00.000Z',
    ])
  })

  test('a closed day offers nothing', async () => {
    const service = await seed(db)
    await db.insert(availabilityExceptions).values({
      vendorId: null,
      date: WEDNESDAY,
      startMinute: null,
      endMinute: null,
      timezone: 'UTC',
      note: 'Bank holiday',
    })
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      now: NOW,
    })
    expect(slots.length).toBe(0)
  })

  test('an exception with hours replaces the day rather than adding to it', async () => {
    const service = await seed(db)
    await db.insert(availabilityExceptions).values({
      vendorId: null,
      date: WEDNESDAY,
      startMinute: 18 * 60,
      endMinute: 20 * 60,
      timezone: 'UTC',
      note: 'Late opening',
    })
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      now: NOW,
    })
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-06-10T18:00:00.000Z',
      '2026-06-10T19:00:00.000Z',
    ])
  })

  test('nothing is offered inside the notice period', async () => {
    const service = await seed(db, { leadMinutes: 24 * 60 })
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      // The morning of the same day, with a day's notice required.
      now: at(6),
    })
    expect(slots.length).toBe(0)
  })
})

describe('holding a slot', () => {
  test('a paid service is held, not confirmed', async () => {
    const service = await seed(db)
    const held = await holdSlot(
      db,
      service,
      { startsAt: at(10), buyerEmail: 'buyer@example.com' },
      NOW,
    )
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(held.confirmed).toBe(false)
    expect(held.booking.status).toBe('held')
    expect(held.booking.holdExpiresAt).not.toBeNull()

    // Twelve five-minute cells for an hour.
    const cells = await db.select().from(bookingSlots)
    expect(cells.length).toBe(12)
    expect(cells.every((cell) => cell.resourceKey === 'house')).toBe(true)
  })

  test('a free service is confirmed on the spot', async () => {
    const service = await seed(db, { price: 0 })
    const held = await holdSlot(
      db,
      service,
      { startsAt: at(10), buyerEmail: 'buyer@example.com' },
      NOW,
    )
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(held.confirmed).toBe(true)
    expect(held.booking.status).toBe('confirmed')
    // Nothing to wait for, so nothing to expire.
    expect(held.booking.holdExpiresAt).toBeNull()
  })

  test('a time outside the diary is refused', async () => {
    const service = await seed(db)
    const held = await holdSlot(
      db,
      service,
      { startsAt: at(3), buyerEmail: 'buyer@example.com' },
      NOW,
    )
    expect(held.ok).toBe(false)
    if (held.ok) return
    expect(held.reason).toBe('not-offered')
  })

  test('a held slot stops being offered', async () => {
    const service = await seed(db)
    await holdSlot(db, service, { startsAt: at(10), buyerEmail: 'a@b.c' }, NOW)
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      now: NOW,
    })
    expect(slots.map((slot) => slot.startsAt)).not.toContain(
      '2026-06-10T10:00:00.000Z',
    )
    expect(slots.length).toBe(7)
  })
})

describe('two people, one Thursday afternoon', () => {
  test('the second is refused, not given the same time', async () => {
    const service = await seed(db)

    // Interleaved rather than sequential. Both calls read the diary before
    // either writes to it, which is the exact ordering that a check-then-insert
    // gets wrong and the reason the constraint exists.
    const [first, second] = await Promise.all([
      holdSlot(db, service, { startsAt: at(11), buyerEmail: 'first@example.com' }, NOW),
      holdSlot(db, service, { startsAt: at(11), buyerEmail: 'second@example.com' }, NOW),
    ])

    const winners = [first, second].filter((result) => result.ok)
    expect(winners.length).toBe(1)

    const loser = [first, second].find((result) => !result.ok)
    expect(loser).toBeDefined()
    // `taken` specifically, which means the refusal came from the unique index
    // and not from the diary read. Both callers saw a free slot; the database
    // is what separated them. If this ever reads `not-offered` the test has
    // stopped exercising the race it was written for.
    expect(loser!.ok === false && loser!.reason).toBe('taken')

    // And the database agrees: one appointment, one set of cells.
    const live = await db.select().from(bookings).where(eq(bookings.status, 'held'))
    expect(live.length).toBe(1)
    expect((await db.select().from(bookingSlots)).length).toBe(12)
  })

  test('appointments that merely overlap collide too', async () => {
    // The case a unique index on the start time would let through: 11:00–12:00
    // and 11:30–12:30 share no start, and half an hour of diary.
    const service = await seed(db)
    const first = await holdSlot(
      db,
      service,
      { startsAt: at(11), buyerEmail: 'first@example.com' },
      NOW,
    )
    expect(first.ok).toBe(true)

    // Reached directly, because the slot generator would not offer 11:30 —
    // this is about what happens when a request names it anyway.
    let refused = false
    try {
      await db.insert(bookingSlots).values({
        bookingId: first.ok ? first.booking.id : 0,
        resourceKey: 'house',
        // 11:30, which is inside the 11:00–12:00 appointment.
        slotStart: Math.floor(at(11, 30).getTime() / 1000),
      })
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })

  test('two vendors may hold the same instant', async () => {
    // The other half of the same guarantee: the index must refuse a clash and
    // must not invent one. Different diaries, same clock.
    const service = await seed(db)
    const held = await holdSlot(
      db,
      service,
      { startsAt: at(12), buyerEmail: 'first@example.com' },
      NOW,
    )
    expect(held.ok).toBe(true)

    await db.insert(bookingSlots).values({
      bookingId: held.ok ? held.booking.id : 0,
      resourceKey: 'v7',
      slotStart: Math.floor(at(12).getTime() / 1000),
    })
    expect((await db.select().from(bookingSlots)).length).toBe(13)
  })
})

describe('giving the time back', () => {
  test('an abandoned hold releases its slot', async () => {
    const service = await seed(db)
    const held = await holdSlot(
      db,
      service,
      { startsAt: at(14), buyerEmail: 'ghost@example.com' },
      NOW,
    )
    expect(held.ok).toBe(true)

    // Sixteen minutes later, with a fifteen-minute hold.
    const released = await expireHolds(db, new Date(NOW.getTime() + 16 * 60_000))
    expect(released).toBe(1)

    // The time is free again...
    expect((await db.select().from(bookingSlots)).length).toBe(0)
    const slots = await slotsFor(db, service, {
      from: at(0),
      to: at(23, 59),
      now: NOW,
    })
    expect(slots.map((slot) => slot.startsAt)).toContain(
      '2026-06-10T14:00:00.000Z',
    )

    // ...and what happened is still on the record.
    const [row] = await db.select().from(bookings)
    expect(row!.status).toBe('expired')
  })

  test('a hold that has not expired keeps its slot', async () => {
    const service = await seed(db)
    await holdSlot(db, service, { startsAt: at(14), buyerEmail: 'a@b.c' }, NOW)
    expect(await expireHolds(db, new Date(NOW.getTime() + 60_000))).toBe(0)
    expect((await db.select().from(bookingSlots)).length).toBe(12)
  })

  test('cancelling frees the time and keeps the appointment', async () => {
    const service = await seed(db, { price: 0 })
    const held = await holdSlot(
      db,
      service,
      { startsAt: at(15), buyerEmail: 'a@b.c' },
      NOW,
    )
    expect(held.ok).toBe(true)
    if (!held.ok) return

    expect(await cancelBooking(db, held.booking.id, 'buyer')).toBe(true)
    expect((await db.select().from(bookingSlots)).length).toBe(0)

    const [row] = await db.select().from(bookings)
    expect(row!.status).toBe('cancelled')

    // And cancelling twice is not a second cancellation.
    expect(await cancelBooking(db, held.booking.id, 'buyer')).toBe(false)
  })

  test('a cancelled slot can be booked by somebody else', async () => {
    const service = await seed(db, { price: 0 })
    const first = await holdSlot(
      db,
      service,
      { startsAt: at(15), buyerEmail: 'first@example.com' },
      NOW,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await cancelBooking(db, first.booking.id, 'buyer')

    const second = await holdSlot(
      db,
      service,
      { startsAt: at(15), buyerEmail: 'second@example.com' },
      NOW,
    )
    expect(second.ok).toBe(true)
  })
})
