import { and, eq, inArray, lt } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { bookingSlots, bookings, services as servicesTable } from '#/db/schema'
import { record } from '../events'
import { cellsFor } from './time'
import { isOffered, occupiedMinutes, resourceKeyFor } from './slots'
import type { Service } from './slots'

/**
 * Taking a time off the diary, and giving it back.
 *
 * The whole correctness argument for this feature lives in one function. Two
 * people click the same 3pm within the same second; both pass every check that
 * reads the diary, because at the moment each of them read it the slot was
 * free. What separates them is the unique index on `booking_slots` — one insert
 * lands and the other is refused by the database, and the loser is told so
 * rather than being given an appointment that does not exist.
 *
 * So the checks below are for producing good messages, and the constraint is
 * for being right. It is worth being explicit about which is which, because the
 * version of this code that only checks looks identical and works in testing.
 */

export type HoldFailure =
  | { ok: false; reason: 'not-bookable'; message: string }
  | { ok: false; reason: 'not-offered'; message: string }
  | { ok: false; reason: 'taken'; message: string }

export type HoldResult =
  | {
      ok: true
      booking: typeof bookings.$inferSelect
      /** whether it is already theirs, or waiting on a payment */
      confirmed: boolean
    }
  | HoldFailure

function newReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return `bkg_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Releases holds nobody completed.
 *
 * Lazily, at the front of every path that reads or writes the diary, rather
 * than on a timer. A node has no scheduler of its own, and more to the point a
 * hold that expired an hour ago only matters at the moment somebody asks for
 * that time — so asking is exactly when it is worth cleaning up.
 *
 * The booking row survives, marked `expired`. Only its slot rows go, and those
 * are the ones holding the time. An abandoned checkout is worth being able to
 * see; the Thursday afternoon it was sitting on is not worth losing.
 */
export async function expireHolds(db: NodeDb, now = new Date()): Promise<number> {
  const stale = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.status, 'held'), lt(bookings.holdExpiresAt, now)))
    .limit(200)
  if (stale.length === 0) return 0

  const ids = stale.map((row) => row.id)
  await db.delete(bookingSlots).where(inArray(bookingSlots.bookingId, ids))
  await db
    .update(bookings)
    .set({ status: 'expired' })
    .where(inArray(bookings.id, ids))
  return ids.length
}

/**
 * Holds a slot for somebody.
 *
 * A free service is confirmed here and now — there is no payment to wait for,
 * and holding a slot against a payment that will never be made would mean the
 * buyer having to come back and finish something already finished.
 */
export async function holdSlot(
  db: NodeDb,
  service: Service,
  input: {
    startsAt: Date
    buyerUserId?: string | null
    buyerEmail?: string | null
    buyerName?: string | null
    note?: string | null
  },
  now = new Date(),
): Promise<HoldResult> {
  if (service.status !== 'published') {
    return {
      ok: false,
      reason: 'not-bookable',
      message: 'That is not taking bookings.',
    }
  }

  await expireHolds(db, now)

  if (!(await isOffered(db, service, input.startsAt, now))) {
    return {
      ok: false,
      reason: 'not-offered',
      message: 'That time is not available.',
    }
  }

  const occupied = occupiedMinutes(service)
  const endsAt = new Date(
    input.startsAt.getTime() + service.durationMinutes * 60_000,
  )
  const free = service.price <= 0

  const [booking] = await db
    .insert(bookings)
    .values({
      reference: newReference(),
      serviceId: service.id,
      vendorId: service.vendorId ?? null,
      buyerUserId: input.buyerUserId ?? null,
      buyerEmail: input.buyerEmail ?? null,
      buyerName: input.buyerName ?? null,
      note: input.note ?? null,
      startsAt: input.startsAt,
      endsAt,
      status: free ? 'confirmed' : 'held',
      holdExpiresAt: free
        ? null
        : new Date(now.getTime() + service.holdMinutes * 60_000),
    })
    .returning()

  try {
    await db.insert(bookingSlots).values(
      cellsFor(input.startsAt, occupied).map((cell) => ({
        bookingId: booking!.id,
        resourceKey: resourceKeyFor(service.vendorId),
        slotStart: cell,
      })),
    )
  } catch {
    /*
      The database refused, which means somebody else got there first — between
      `isOffered` returning true and this insert running. That window is real
      and cannot be closed by checking harder; it is closed by the constraint.

      The booking row is taken back out rather than left as `expired`, because
      nothing happened: this is not an appointment somebody abandoned, it is one
      that was never made.
    */
    await db.delete(bookings).where(eq(bookings.id, booking!.id))
    return {
      ok: false,
      reason: 'taken',
      message: 'That time has just been taken. Please choose another.',
    }
  }

  await record(db, {
    name: free ? 'booking.confirmed' : 'booking.held',
    vendorId: service.vendorId ?? null,
    subjectType: 'bookings',
    subjectId: booking!.id,
    detail: {
      reference: booking!.reference,
      serviceId: service.id,
      startsAt: input.startsAt.toISOString(),
    },
  })

  return { ok: true, booking: booking!, confirmed: free }
}

/**
 * Confirms every booking on a paid order.
 *
 * Its slots are already held, so this changes a status and lets the hold stop
 * expiring. Nothing is re-checked: the time was taken at hold, and re-deciding
 * whether it was available after somebody has paid for it would be the one
 * moment it is too late to say no.
 */
export async function confirmForOrder(
  db: NodeDb,
  orderId: number,
): Promise<number> {
  const held = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.orderId, orderId), eq(bookings.status, 'held')))

  for (const booking of held) {
    await db
      .update(bookings)
      .set({ status: 'confirmed', holdExpiresAt: null })
      .where(eq(bookings.id, booking.id))
    await record(db, {
      name: 'booking.confirmed',
      vendorId: booking.vendorId,
      subjectType: 'bookings',
      subjectId: booking.id,
      detail: { reference: booking.reference, orderId },
    })
  }
  return held.length
}

/**
 * Cancels a booking and gives the time back.
 *
 * Used by a refund and by somebody calling off an appointment, which are the
 * same act as far as the diary is concerned. The row stays — an appointment
 * that was cancelled is a different thing from one that never existed, and the
 * person whose Thursday it was may well ask.
 */
export async function cancelBooking(
  db: NodeDb,
  bookingId: number,
  reason: string,
): Promise<boolean> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)
  if (!booking) return false
  if (booking.status === 'cancelled' || booking.status === 'expired') return false

  await db.delete(bookingSlots).where(eq(bookingSlots.bookingId, bookingId))
  await db
    .update(bookings)
    .set({ status: 'cancelled', holdExpiresAt: null })
    .where(eq(bookings.id, bookingId))

  await record(db, {
    name: 'booking.cancelled',
    vendorId: booking.vendorId,
    subjectType: 'bookings',
    subjectId: bookingId,
    detail: { reference: booking.reference, reason },
  })
  return true
}

/** Every booking on an order, cancelled — what a refund means for a diary. */
export async function cancelForOrder(
  db: NodeDb,
  orderId: number,
): Promise<number> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.orderId, orderId))
  let cancelled = 0
  for (const row of rows) {
    if (await cancelBooking(db, row.id, 'refunded')) cancelled += 1
  }
  return cancelled
}

/** A published service by slug, for the public endpoints. */
export async function serviceBySlug(
  db: NodeDb,
  slug: string,
): Promise<Service | null> {
  const [row] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.slug, slug))
    .limit(1)
  return row ?? null
}
