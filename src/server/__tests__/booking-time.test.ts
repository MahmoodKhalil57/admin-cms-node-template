import { describe, expect, test } from 'bun:test'

import {
  SLOT_MINUTES,
  cellsFor,
  dateKey,
  knownZone,
  localParts,
  weekdayOf,
  zonedToUtc,
} from '../booking/time'

/**
 * Local wall time to instants.
 *
 * The reason this is tested harder than the rest of the feature: every bug in
 * a scheduler that anybody remembers is here. An appointment an hour out twice
 * a year, a Sunday that starts on Saturday, a slot that exists in the diary and
 * not in reality. All of them are this function, and none of them show up in
 * testing unless the test names a date in the other half of the year.
 */

describe('resolving a local time', () => {
  test('a zone with no offset is itself', () => {
    expect(zonedToUtc('UTC', 2026, 3, 15, 9 * 60).toISOString()).toBe(
      '2026-03-15T09:00:00.000Z',
    )
  })

  test('the same rule is a different instant in winter and summer', () => {
    // This is the whole reason the column stores a zone rather than an offset.
    // "09:00 in London" is 09:00Z in January and 08:00Z in July, and a stored
    // offset could only ever have been right about one of them.
    expect(zonedToUtc('Europe/London', 2026, 1, 15, 9 * 60).toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    )
    expect(zonedToUtc('Europe/London', 2026, 7, 15, 9 * 60).toISOString()).toBe(
      '2026-07-15T08:00:00.000Z',
    )
  })

  test('a zone ahead of UTC', () => {
    // Gulf Standard Time, +4 all year — no DST, which is what makes it a
    // useful control against the London case above.
    expect(zonedToUtc('Asia/Dubai', 2026, 1, 15, 9 * 60).toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    )
    expect(zonedToUtc('Asia/Dubai', 2026, 7, 15, 9 * 60).toISOString()).toBe(
      '2026-07-15T05:00:00.000Z',
    )
  })

  test('a half-hour offset', () => {
    // India is +05:30. A two-pass solve has to land on the half hour, not the
    // hour, which is the thing a single pass gets wrong on some zones.
    expect(zonedToUtc('Asia/Kolkata', 2026, 6, 1, 9 * 60).toISOString()).toBe(
      '2026-06-01T03:30:00.000Z',
    )
  })

  test('a zone behind UTC, across midnight', () => {
    // 00:30 in New York is 05:30Z the same day in summer — but 23:30 local is
    // 03:30Z the *next* day, which is where an off-by-one date appears.
    expect(zonedToUtc('America/New_York', 2026, 6, 1, 30).toISOString()).toBe(
      '2026-06-01T04:30:00.000Z',
    )
    expect(
      zonedToUtc('America/New_York', 2026, 6, 1, 23 * 60 + 30).toISOString(),
    ).toBe('2026-06-02T03:30:00.000Z')
  })

  test('midnight is the start of the day, not the end of it', () => {
    // `hour: '2-digit'` yields 24 rather than 00 on some ICU builds, which
    // would put every midnight rule a full day late.
    const at = zonedToUtc('Europe/London', 2026, 7, 15, 0)
    expect(at.toISOString()).toBe('2026-07-14T23:00:00.000Z')
    expect(localParts('Europe/London', at).hour).toBe(0)
    expect(localParts('Europe/London', at).day).toBe(15)
  })

  test('round trip: what goes in comes back out', () => {
    for (const zone of [
      'UTC',
      'Europe/London',
      'America/Los_Angeles',
      'Asia/Kolkata',
      'Australia/Sydney',
    ]) {
      for (const month of [1, 4, 7, 10]) {
        for (const minute of [0, 9 * 60, 13 * 60 + 45, 23 * 60 + 55]) {
          const at = zonedToUtc(zone, 2026, month, 15, minute)
          const back = localParts(zone, at)
          expect(back.hour * 60 + back.minute).toBe(minute)
          expect(back.day).toBe(15)
          expect(back.month).toBe(month)
        }
      }
    }
  })

  test('the hour that happens twice resolves the same way every time', () => {
    // British clocks go back at 02:00 on 25 October 2026, so 01:30 local
    // happens at 00:30Z and again at 01:30Z. This lands on the second, and the
    // property being tested is not *which* — it is that the answer never
    // changes, because the same request resolving differently on two requests
    // is two people given the same appointment an hour apart.
    const first = zonedToUtc('Europe/London', 2026, 10, 25, 90)
    const again = zonedToUtc('Europe/London', 2026, 10, 25, 90)
    expect(first.toISOString()).toBe(again.toISOString())
    expect(first.toISOString()).toBe('2026-10-25T01:30:00.000Z')

    // And whichever it is, it is a real instant that reads back as the time
    // that was asked for.
    expect(localParts('Europe/London', first).hour).toBe(1)
    expect(localParts('Europe/London', first).minute).toBe(30)
  })

  test('an hour that does not exist does not become an appointment nobody can attend', () => {
    // Clocks go forward at 01:00 on 29 March 2026, so 01:30 local never
    // happens. Whatever it resolves to must be a real instant, and it must be
    // after the gap rather than before it — an appointment at 00:30Z would be
    // half an hour before the time the buyer thinks they picked.
    const at = zonedToUtc('Europe/London', 2026, 3, 29, 90)
    expect(Number.isNaN(at.getTime())).toBe(false)
    expect(at.toISOString()).toBe('2026-03-29T01:30:00.000Z')
  })

  test('an unknown zone is caught rather than assumed', () => {
    expect(knownZone('Europe/London')).toBe(true)
    expect(knownZone('Middle/Earth')).toBe(false)
  })
})

describe('dates and weekdays', () => {
  test('weekday matches the calendar', () => {
    // 15 March 2026 is a Sunday.
    expect(weekdayOf(2026, 3, 15)).toBe(0)
    expect(weekdayOf(2026, 3, 16)).toBe(1)
  })

  test('date keys are zero-padded, because they are compared as strings', () => {
    expect(dateKey(2026, 3, 5)).toBe('2026-03-05')
  })
})

describe('the cells an appointment occupies', () => {
  test('a slot per grid step, covering the whole appointment', () => {
    const at = new Date('2026-03-15T09:00:00.000Z')
    const cells = cellsFor(at, 30)
    expect(cells.length).toBe(30 / SLOT_MINUTES)
    expect(cells[0]).toBe(Math.floor(at.getTime() / 1000))
    expect(cells.at(-1)).toBe(
      Math.floor(at.getTime() / 1000) + (30 - SLOT_MINUTES) * 60,
    )
  })

  test('the buffer is occupied too', () => {
    // A minute somebody else can book into is not a gap, so a 30-minute
    // appointment with a 15-minute buffer holds 45 minutes of diary.
    const at = new Date('2026-03-15T09:00:00.000Z')
    expect(cellsFor(at, 45).length).toBe(9)
  })

  test('two appointments that overlap share a cell', () => {
    // The whole anti-double-booking argument in one assertion: 10:00–11:00 and
    // 10:30–11:30 do not share a start, so an index on the start would admit
    // both. They do share cells, which is what the unique index sees.
    const first = cellsFor(new Date('2026-03-15T10:00:00.000Z'), 60)
    const second = cellsFor(new Date('2026-03-15T10:30:00.000Z'), 60)
    expect(first.some((cell) => second.includes(cell))).toBe(true)
  })

  test('two appointments that merely touch do not', () => {
    const first = cellsFor(new Date('2026-03-15T10:00:00.000Z'), 60)
    const second = cellsFor(new Date('2026-03-15T11:00:00.000Z'), 60)
    expect(first.some((cell) => second.includes(cell))).toBe(false)
  })
})

describe('a timezone somebody typed wrong', () => {
  test('reads as UTC rather than taking the diary down', () => {
    // Rules are written through the generic REST layer, which does not
    // validate a field it knows nothing about. So a typo reaches this code,
    // and the choice is between one visibly-wrong rule and a 500 on the public
    // endpoint every booking page calls.
    expect(() => zonedToUtc('Europe/Londn', 2026, 7, 15, 9 * 60)).not.toThrow()
    expect(zonedToUtc('Europe/Londn', 2026, 7, 15, 9 * 60).toISOString()).toBe(
      '2026-07-15T09:00:00.000Z',
    )
    // And it is still reported as the mistake it is.
    expect(knownZone('Europe/Londn')).toBe(false)
  })
})
