import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  availabilityExceptions,
  availabilityRules,
  bookingSlots,
} from '#/db/schema'
import type { services } from '#/db/schema'
import {
  SLOT_MINUTES,
  addDays,
  cellsFor,
  dateKey,
  localParts,
  weekdayOf,
  zonedToUtc,
} from './time'

export type Service = typeof services.$inferSelect

/**
 * What times are actually on offer.
 *
 * Built by resolving the weekly pattern on each local date in range, taking the
 * exceptions into account, and then removing everything already occupied. The
 * order matters: availability is a description of intent and occupancy is a
 * fact, so the facts are applied last and cannot be overridden by a rule.
 *
 * Nothing here is authoritative. A slot offered by this function can be taken
 * between the page rendering and the buyer clicking, which is why the hold path
 * relies on a database constraint rather than on this having been checked. This
 * is what to *show*; `booking_slots` is what is *true*.
 */

/**
 * The non-null key an appointment occupies time under.
 *
 * `house` for a single-vendor node, where `vendorId` is null. Not cosmetic:
 * SQLite considers NULLs distinct in a unique index, so a key of null would
 * make the anti-double-booking index admit every collision it exists to refuse,
 * on exactly the nodes least likely to have noticed.
 */
export function resourceKeyFor(vendorId: number | null | undefined): string {
  return vendorId ? `v${vendorId}` : 'house'
}

/** Time an appointment holds: its own length plus whatever follows it. */
export function occupiedMinutes(service: Service): number {
  return service.durationMinutes + service.bufferMinutes
}

export interface Slot {
  /** ISO 8601, always UTC */
  startsAt: string
  endsAt: string
}

interface Window {
  startMinute: number
  endMinute: number
  timezone: string
}

/**
 * Every slot for a service between two instants.
 *
 * Bounded twice over — by the service's own horizon and by a hard cap on the
 * number of days walked — because this is reachable from a public endpoint and
 * a caller asking for the year 2400 should get an empty answer rather than a
 * Worker spending its CPU budget on arithmetic nobody wanted.
 */
export async function slotsFor(
  db: NodeDb,
  service: Service,
  range: { from: Date; to: Date; now?: Date },
): Promise<Array<Slot>> {
  const now = range.now ?? new Date()
  const duration = service.durationMinutes
  const step = occupiedMinutes(service)
  if (duration <= 0 || duration % SLOT_MINUTES !== 0) return []

  // A booking must be at least this far out, and no further than that.
  const earliest = new Date(now.getTime() + service.leadMinutes * 60_000)
  const latest = new Date(now.getTime() + service.horizonDays * 86_400_000)
  const from = new Date(Math.max(range.from.getTime(), earliest.getTime()))
  const to = new Date(Math.min(range.to.getTime(), latest.getTime()))
  if (from >= to) return []

  const rules = await db
    .select()
    .from(availabilityRules)
    .where(
      service.vendorId
        ? eq(availabilityRules.vendorId, service.vendorId)
        : isNull(availabilityRules.vendorId),
    )
  if (rules.length === 0) return []

  // The zone the diary is kept in. Rules for one vendor share it in practice;
  // if they somehow do not, the first is what dates are walked in and each rule
  // still resolves in its own.
  const zone = rules[0]!.timezone

  const exceptions = await db
    .select()
    .from(availabilityExceptions)
    .where(
      service.vendorId
        ? eq(availabilityExceptions.vendorId, service.vendorId)
        : isNull(availabilityExceptions.vendorId),
    )
  const byDate = new Map<string, Array<typeof exceptions[number]>>()
  for (const row of exceptions) {
    const list = byDate.get(row.date) ?? []
    list.push(row)
    byDate.set(row.date, list)
  }

  const taken = await occupiedCells(db, resourceKeyFor(service.vendorId), from, to)

  const start = localParts(zone, from)
  const slots: Array<Slot> = []
  const MAX_DAYS = 120

  for (let offset = 0; offset <= MAX_DAYS; offset += 1) {
    const date = addDays(start.year, start.month, start.day, offset)
    const key = dateKey(date.year, date.month, date.day)

    // Past the far end: the first slot of this day already exceeds the range.
    if (zonedToUtc(zone, date.year, date.month, date.day, 0) > to) break

    const windows = windowsFor(
      rules,
      byDate.get(key) ?? [],
      weekdayOf(date.year, date.month, date.day),
      zone,
    )

    for (const window of windows) {
      for (
        let minute = window.startMinute;
        minute + duration <= window.endMinute;
        minute += step
      ) {
        const startsAt = zonedToUtc(
          window.timezone,
          date.year,
          date.month,
          date.day,
          minute,
        )
        if (startsAt < from || startsAt > to) continue
        if (cellsFor(startsAt, step).some((cell) => taken.has(cell))) continue
        slots.push({
          startsAt: startsAt.toISOString(),
          endsAt: new Date(
            startsAt.getTime() + duration * 60_000,
          ).toISOString(),
        })
      }
    }
  }

  // Days are walked in order but a DST shift can put two days' slots a minute
  // out of sequence, and a list a page renders should be in time order.
  slots.sort((left, right) => left.startsAt.localeCompare(right.startsAt))
  return slots
}

/**
 * The hours open on one date.
 *
 * An exception with a window replaces the day's rules; one without closes the
 * day entirely. Replacing rather than intersecting is the behaviour an operator
 * expects from "open late on the 14th" — they are describing the day, not
 * adding to it.
 */
function windowsFor(
  rules: Array<typeof availabilityRules.$inferSelect>,
  exceptions: Array<typeof availabilityExceptions.$inferSelect>,
  weekday: number,
  zone: string,
): Array<Window> {
  if (exceptions.length > 0) {
    const closed = exceptions.some(
      (row) => row.startMinute === null || row.endMinute === null,
    )
    if (closed) return []
    return exceptions
      .filter((row) => row.startMinute !== null && row.endMinute !== null)
      .map((row) => ({
        startMinute: row.startMinute!,
        endMinute: row.endMinute!,
        timezone: row.timezone || zone,
      }))
  }

  return rules
    .filter((rule) => rule.weekday === weekday && rule.endMinute > rule.startMinute)
    .map((rule) => ({
      startMinute: rule.startMinute,
      endMinute: rule.endMinute,
      timezone: rule.timezone || zone,
    }))
}

/** Every grid cell already spoken for, as a set of unix seconds. */
async function occupiedCells(
  db: NodeDb,
  resourceKey: string,
  from: Date,
  to: Date,
): Promise<Set<number>> {
  const rows = await db
    .select({ slotStart: bookingSlots.slotStart })
    .from(bookingSlots)
    .where(
      and(
        eq(bookingSlots.resourceKey, resourceKey),
        // A day either side, so an appointment that starts before the window
        // and runs into it still blocks what it covers.
        gte(bookingSlots.slotStart, Math.floor(from.getTime() / 1000) - 86_400),
        lte(bookingSlots.slotStart, Math.floor(to.getTime() / 1000) + 86_400),
      ),
    )
  return new Set(rows.map((row) => row.slotStart))
}

/**
 * Whether one specific instant is a slot this service actually offers.
 *
 * Asked at the moment of holding, because the times a page was rendered with
 * may be minutes or days old and a request naming an arbitrary instant must not
 * be able to book outside the diary. Cheap: it generates the day the instant
 * falls on rather than the whole horizon.
 */
export async function isOffered(
  db: NodeDb,
  service: Service,
  startsAt: Date,
  now?: Date,
): Promise<boolean> {
  const slots = await slotsFor(db, service, {
    from: new Date(startsAt.getTime() - 60_000),
    to: new Date(startsAt.getTime() + 60_000),
    now,
  })
  return slots.some((slot) => slot.startsAt === startsAt.toISOString())
}

export { inArray, or }
