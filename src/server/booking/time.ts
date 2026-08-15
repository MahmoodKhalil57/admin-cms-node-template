/**
 * Turning local wall-clock time into instants, and back.
 *
 * A rule says "Tuesdays, 09:00, Europe/London". That is not an instant — it is
 * a description that resolves to a different instant depending on the date,
 * because the offset between London and UTC changes twice a year. Every slot
 * this scheduler offers has to be computed by resolving the description on the
 * day it falls, and there is no shortcut that stores the answer once.
 *
 * The runtime already knows all of this. `Intl.DateTimeFormat` carries the full
 * IANA database and is available in Workers, so none of it needs a dependency —
 * what it does not provide is the inverse direction, which is what `zonedToUtc`
 * builds out of it.
 */

/** The grid every appointment is aligned to. Durations must be a multiple. */
export const SLOT_MINUTES = 5

const MINUTE = 60_000

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 is Sunday, matching `Date.getUTCDay` */
  weekday: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const formatters = new Map<string, Intl.DateTimeFormat>()

const OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
}

/**
 * A formatter for a zone, falling back to UTC when the name is not one.
 *
 * The fallback is not politeness. Rules are written through the generic REST
 * layer, which has no per-field validation, so a typed-in `Europe/Londn`
 * reaches this function — and an exception here surfaces as a 500 on the public
 * endpoint a booking page calls, taking the whole diary down over one bad row.
 * Falling back means that rule reads as UTC, which is visibly wrong to whoever
 * wrote it and leaves everybody else's appointments working.
 */
function formatterFor(zone: string): Intl.DateTimeFormat {
  const seen = formatters.get(zone)
  if (seen) return seen
  let made: Intl.DateTimeFormat
  try {
    made = new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone: zone })
  } catch {
    made = new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone: 'UTC' })
  }
  formatters.set(zone, made)
  return made
}

/** Whether the runtime recognises a zone, so a bad rule can be reported as one. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { ...OPTIONS, timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** What the clock says in `zone` at a given instant. */
export function localParts(zone: string, at: Date): LocalParts {
  const parts = Object.fromEntries(
    formatterFor(zone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // `h23` still yields 24 for midnight on some ICU builds, which would make
    // a midnight rule land a day late.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: Math.max(WEEKDAYS.indexOf(parts.weekday ?? 'Sun'), 0),
  }
}

/** How far `zone` is from UTC at a given instant, in milliseconds. */
function offsetAt(zone: string, at: Date): number {
  const local = localParts(zone, at)
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  )
  return asIfUtc - at.getTime()
}

/**
 * The instant at which the clock in `zone` reads this local date and minute.
 *
 * Solved by iteration rather than by table lookup, because the offset depends
 * on the instant and the instant is what is being solved for. Two passes is
 * enough: the first lands within an hour of the answer, which is close enough
 * for the second to read the correct offset on every real zone, including the
 * half-hour and three-quarter-hour ones.
 *
 * **The ambiguous hours resolve to something real, which is the property that
 * matters.** Twice a year a named local time either does not exist or happens
 * twice. A missing one lands just after the gap — 01:30 on a spring-forward
 * morning becomes 02:30 local, never an instant nobody can attend. A repeated
 * one lands on the second pass of the clock, after the transition.
 *
 * The consequence, said plainly rather than left to be discovered: on the one
 * morning a year the clocks go back, the hour before the change offers no slots,
 * because every local time in it resolves to its later twin. An hour of
 * availability is lost once a year. Picking the earlier twin instead would lose
 * the same hour at the other end, so there is no version of this that keeps
 * both — what there is, is a version that always resolves the same way, which
 * is what stops the same request producing two different appointments.
 */
export function zonedToUtc(
  zone: string,
  year: number,
  month: number,
  day: number,
  minute: number,
): Date {
  const wanted = Date.UTC(year, month - 1, day, 0, minute)
  let guess = wanted - offsetAt(zone, new Date(wanted))
  guess = wanted - offsetAt(zone, new Date(guess))
  return new Date(guess)
}

/** `YYYY-MM-DD` for a local date, which is how exceptions are keyed. */
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The local date `n` days after another, arithmetic done in plain UTC. */
export function addDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const at = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000)
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
  }
}

/** 0 Sunday … 6 Saturday, for a local date. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * The grid cells an appointment covers.
 *
 * Every cell it occupies, including its buffer — a gap somebody else can book
 * into is not a gap. Seconds rather than milliseconds because that is what the
 * column stores and what SQLite compares.
 */
export function cellsFor(startsAt: Date, minutes: number): Array<number> {
  const start = Math.floor(startsAt.getTime() / 1000)
  const count = Math.max(Math.ceil(minutes / SLOT_MINUTES), 1)
  const cells: Array<number> = []
  for (let index = 0; index < count; index += 1) {
    cells.push(start + index * SLOT_MINUTES * 60)
  }
  return cells
}

/** Minutes since local midnight, for comparing against a rule. */
export function minuteOfDay(zone: string, at: Date): number {
  const local = localParts(zone, at)
  return local.hour * 60 + local.minute
}

export { MINUTE }
