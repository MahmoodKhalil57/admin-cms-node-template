import { and, count, gte, lt } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { events } from '#/db/schema'
import type { NodeEnv } from './env'
import { PRICE_LIST_VERSION, creditsFor, itemsFor, periodOf } from '#/lib/price-list'

/**
 * What this node used, and what that costs in credits.
 *
 * **The property that makes this cheap to have built late: it is derived, not
 * accumulated.** Counted usage is a query over the event log, which has been
 * written since the day the node ran — so metering a month that has already
 * happened gives the same answer as metering it at the time. That is the
 * opposite of the usual meter, which can only ever count forward from the day
 * somebody installed it, and it is why M0 was worth shipping first.
 *
 * The consequence worth stating: **re-reporting a period is safe by
 * construction.** A retry recomputes the same numbers, and master stores them
 * by replacing rather than adding. There is no "have I sent this already"
 * question to get wrong, which is the usual way a usage pipeline double-bills.
 *
 * Measured usage is the other half and does not have this property. A sample is
 * only true for the moment it was taken, so a month that has passed cannot be
 * re-measured. Storage is sampled here; the rest is declared and not yet
 * counted, and says so rather than reading zero.
 */

export interface MeterLine {
  item: string
  quantity: number
  credits: number
  /** whether the figure was counted from the log or sampled from the world */
  source: 'events' | 'measured'
  /** declared in the price list but nothing measures it yet */
  pending?: boolean
}

export interface MeterReading {
  period: string
  priceListVersion: number
  lines: Array<MeterLine>
  /** what the whole period comes to */
  credits: number
  takenAt: string
}

/** The instants a `YYYY-MM` period covers, in UTC. */
export function boundsOf(period: string): { from: Date; to: Date } {
  const [year, month] = period.split('-').map(Number)
  const from = new Date(Date.UTC(year!, month! - 1, 1))
  const to = new Date(Date.UTC(year!, month!, 1))
  return { from, to }
}

export async function meter(
  env: NodeEnv,
  db: NodeDb,
  period = periodOf(),
): Promise<MeterReading> {
  const { from, to } = boundsOf(period)
  const lines: Array<MeterLine> = []

  // One grouped query for every counted item, rather than one query per item.
  const counted = await countsByName(db, from, to)

  // Only what the node itself is billed for. A vendor's own sale is a
  // service the node provides, not one it buys, and appears on their bill
  // rather than on this one.
  for (const item of itemsFor('node')) {
    if (item.source === 'events') {
      const quantity = counted.get(item.eventName ?? '') ?? 0
      lines.push({
        item: item.key,
        quantity,
        credits: creditsFor(item, quantity),
        source: 'events',
      })
      continue
    }

    if (item.key === 'storage') {
      const bytes = await storageBytes(env)
      lines.push({
        item: item.key,
        quantity: bytes,
        credits: creditsFor(item, bytes),
        source: 'measured',
      })
      continue
    }

    // Declared, not measured. Reported as zero *and* flagged, because a zero
    // that means "nobody counted" must not be read as a zero that means "none
    // used" — the second is a fact and the first is a gap.
    lines.push({
      item: item.key,
      quantity: 0,
      credits: 0,
      source: 'measured',
      pending: true,
    })
  }

  return {
    period,
    priceListVersion: PRICE_LIST_VERSION,
    lines,
    credits: lines.reduce((sum, line) => sum + line.credits, 0),
    takenAt: new Date().toISOString(),
  }
}

/** Every event name in the period, counted, in one query. */
async function countsByName(
  db: NodeDb,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ name: events.name, total: count() })
    .from(events)
    // Exclusive at the top. A period that ended at `<=` the first instant of
    // the next one counts that instant in both, which is the kind of rounding
    // error that never gets found because it is one row a month.
    .where(and(gte(events.createdAt, from), lt(events.createdAt, to)))
    .groupBy(events.name)
  return new Map(rows.map((row) => [row.name, Number(row.total)]))
}

/**
 * How many bytes are sitting in this node's own bucket.
 *
 * Measured by listing it, which is the honest answer available at zero cost:
 * the bucket belongs to this node, so unlike egress or CPU there is nothing to
 * attribute — what is in it *is* this node's storage.
 *
 * Bounded. A bucket with more objects than the cap reports what it counted and
 * stops, because a meter that spends a Worker's whole CPU budget on a node with
 * a lot of files is a meter that takes that node down once a month.
 */
const MAX_PAGES = 10

async function storageBytes(env: NodeEnv): Promise<number> {
  if (!env.MEDIA) return 0
  let bytes = 0
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listing = await env.MEDIA.list({ limit: 1000, cursor })
      for (const object of listing.objects) bytes += object.size
      if (!listing.truncated) break
      cursor = listing.cursor
    }
  } catch {
    // A bucket that cannot be read is not a bucket with nothing in it, but
    // there is no third number to report — so it reads zero and the failure
    // does not take the whole reading down with it.
    return bytes
  }
  return bytes
}

/**
 * Sends a reading to master.
 *
 * Over the same service binding the mailer uses, with the same provisioning
 * token — the node is already trusted to ask master to send email as it, and
 * reporting what it used is a smaller claim than that.
 *
 * Failure is not an error worth raising. A reading that did not arrive is
 * recomputed identically next time, because it is derived; master replaces
 * rather than adds. So the retry is "ask again later", and there is nothing to
 * queue, resume or reconcile.
 */
export async function reportUsage(
  env: NodeEnv,
  reading: MeterReading,
): Promise<{ sent: boolean; reason?: string }> {
  if (!env.MASTER || !env.PROVISION_TOKEN) {
    return { sent: false, reason: 'This node cannot reach the platform.' }
  }
  try {
    const response = await env.MASTER.fetch('https://master/api/internal/usage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.PROVISION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug: env.NODE_ID, ...reading }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      return { sent: false, reason: body.error ?? `Master answered ${response.status}.` }
    }
    return { sent: true }
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : 'Master could not be reached.',
    }
  }
}

/**
 * Reports, at most once an hour, and never blocks anything on it.
 *
 * A node has no scheduler — nothing in a dispatch namespace runs on a timer —
 * so reporting happens when somebody is already here. The throttle lives in the
 * node's KV, which is the one piece of per-node state cheap enough to touch on
 * a request that was going to happen anyway.
 *
 * **A node nobody opens does not report, and that is survivable rather than a
 * hole.** Counted usage is derived from the event log, so the first request
 * after a quiet month reports that month correctly and master replaces what it
 * had. The figure that genuinely degrades is the measured one — storage is a
 * sample, and a sample not taken cannot be taken later.
 */
const REPORT_EVERY_MS = 60 * 60 * 1000

export async function maybeReport(
  env: NodeEnv,
  db: NodeDb,
): Promise<{ reported: boolean; reason?: string }> {
  if (!env.KV) return { reported: false, reason: 'No storage for the schedule.' }

  const key = 'meter:last-reported'
  try {
    const last = Number((await env.KV.get(key)) ?? 0)
    if (Date.now() - last < REPORT_EVERY_MS) {
      return { reported: false, reason: 'Reported recently.' }
    }
    // Stamped before the work, not after. Two requests arriving together would
    // otherwise both find a stale stamp and both report — harmless, because the
    // store replaces, and still twice the work for nothing.
    await env.KV.put(key, String(Date.now()))
  } catch {
    return { reported: false, reason: 'The schedule could not be read.' }
  }

  const reading = await meter(env, db)
  const sent = await reportUsage(env, reading)
  return { reported: sent.sent, reason: sent.reason }
}
