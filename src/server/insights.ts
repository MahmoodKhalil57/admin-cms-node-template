import { and, count, eq, gte, inArray, lte, sql, sum } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { events, orderItems, orders } from '#/db/schema'
import { conditionWhere } from '#/lib/rest'
import type { Principal } from './authz'
import { EVENT_CATALOG } from './events'

/**
 * Reading the event log back.
 *
 * Features 5 and 6 are the same feature and this file is where that stops
 * being a claim. There is no per-vendor analytics code anywhere below — there
 * is one set of queries, narrowed by `conditionWhere`, which is the identical
 * function the REST layer uses to decide which rows a list may show. A vendor
 * whose role says `{ vendorId: { mine: true } }` gets their own numbers because
 * their grant says so, not because something here checked for a vendor.
 *
 * Aggregated in SQL rather than by reading rows and counting them in
 * JavaScript. A node that has been busy for a year has more events than a
 * Worker should hold in memory, and the moment this becomes slow is the moment
 * somebody actually has data worth looking at.
 */

/** Long enough to see a pattern, short enough to stay cheap. */
const DEFAULT_DAYS = 30
const MAX_DAYS = 365

export interface Insights {
  from: string
  to: string
  /** how many of each kind of thing happened, most first */
  totals: Array<{ name: string; label: string; area: string; count: number }>
  /** one bucket per day, for drawing */
  series: Array<{ date: string; count: number }>
  /** what it was worth, from the order lines rather than from the log */
  money: {
    currency: string
    /** what buyers paid on lines this reader may see */
    gross: number
    /** of that, what vendors are owed */
    vendorShare: number
    /** and what the platform kept */
    platformFee: number
    /** how many paid orders those lines came from */
    orders: number
  }
  /** the last few things that happened, in words */
  recent: Array<{
    id: number
    name: string
    label: string
    at: string | null
    subjectType: string | null
    subjectId: string | null
  }>
}

function labelFor(name: string): { label: string; area: string } {
  const found = EVENT_CATALOG.find((entry) => entry.key === name)
  // An event recorded by a build newer than this catalog still counts. Showing
  // its raw key is worse than a label and far better than dropping the row,
  // which would make a total quietly disagree with the log it came from.
  return { label: found?.name ?? name, area: found?.area ?? 'Other' }
}

export async function insightsFor(
  db: NodeDb,
  principal: Principal,
  options: { days?: number; now?: Date } = {},
): Promise<Insights> {
  const now = options.now ?? new Date()
  const days = Math.min(Math.max(Math.trunc(options.days ?? DEFAULT_DAYS), 1), MAX_DAYS)
  const from = new Date(now.getTime() - days * 86_400_000)

  /*
    The same narrowing the lists use, on the same grant.

    This one line is the whole of feature 6. Anything that reimplemented it —
    even correctly, today — would be a second place for the rule to live, and
    the second place is the one that stops agreeing with the first.
  */
  const mine = conditionWhere(events, principal, 'events:read')
  const window = and(gte(events.createdAt, from), lte(events.createdAt, now))
  const where = mine ? and(window, mine) : window

  const totals = (
    await db
      .select({ name: events.name, total: count() })
      .from(events)
      .where(where)
      .groupBy(events.name)
  )
    .map((row) => ({ name: row.name, ...labelFor(row.name), count: Number(row.total) }))
    .sort((left, right) => right.count - left.count)

  // Bucketed by day in SQLite rather than in JavaScript, so a busy year is one
  // row per day out of the database instead of a year of rows into the Worker.
  const buckets = await db
    .select({
      date: sql<string>`strftime('%Y-%m-%d', ${events.createdAt}, 'unixepoch')`,
      total: count(),
    })
    .from(events)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`1`)

  const byDate = new Map(buckets.map((row) => [row.date, Number(row.total)]))
  const series: Array<{ date: string; count: number }> = []
  for (let index = 0; index <= days; index += 1) {
    const at = new Date(from.getTime() + index * 86_400_000)
    const key = at.toISOString().slice(0, 10)
    // Days with nothing on them are still days. Leaving them out would draw a
    // chart where a quiet week looks like a missing week.
    series.push({ date: key, count: byDate.get(key) ?? 0 })
  }

  const recent = (
    await db
      .select()
      .from(events)
      .where(where)
      .orderBy(sql`${events.id} desc`)
      .limit(12)
  ).map((row) => ({
    id: row.id,
    name: row.name,
    label: labelFor(row.name).label,
    at: row.createdAt?.toISOString() ?? null,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
  }))

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    totals,
    series,
    money: await moneyFor(db, principal, from, now),
    recent,
  }
}

/**
 * What the period was worth.
 *
 * From `order_items` rather than from the event log, and the distinction
 * matters. The log records that an order was paid and what it totalled, which
 * is enough to count sales and not enough to say whose they were — an order can
 * carry several vendors. The lines know, they carry the split as it was written
 * at the moment of sale, and they are narrowed by the reader's own grant on
 * `sales:read`.
 *
 * A reader with no claim on sales gets zeroes rather than an error: a dashboard
 * that refuses to load because one panel is out of reach is worse than one that
 * shows what it can.
 */
async function moneyFor(
  db: NodeDb,
  principal: Principal,
  from: Date,
  to: Date,
): Promise<Insights['money']> {
  const empty = {
    currency: 'USD',
    gross: 0,
    vendorShare: 0,
    platformFee: 0,
    orders: 0,
  }
  if (!principal.isOwner && !principal.permissions.includes('sales:read')) {
    return empty
  }

  const mine = conditionWhere(orderItems, principal, 'sales:read')

  // Paid orders only. A pending checkout is not takings, and a refunded one is
  // reported by what went back rather than by pretending it never happened.
  const paid = await db
    .select({ id: orders.id, currency: orders.currency })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'paid'),
        gte(orders.paidAt, from),
        lte(orders.paidAt, to),
      ),
    )
  if (paid.length === 0) return empty

  const ids = paid.map((row) => row.id)
  const scope = and(inArray(orderItems.orderId, ids), mine)

  const [row] = await db
    .select({
      gross: sum(orderItems.amount),
      vendorShare: sum(orderItems.vendorShare),
      platformFee: sum(orderItems.platformFee),
      lines: count(),
      // How many distinct orders those lines came from, which is the number a
      // person means by "how many sales" — not how many things were in them.
      orders: sql<number>`count(distinct ${orderItems.orderId})`,
    })
    .from(orderItems)
    .where(scope)

  return {
    currency: paid[0]?.currency ?? 'USD',
    gross: Number(row?.gross ?? 0),
    vendorShare: Number(row?.vendorShare ?? 0),
    platformFee: Number(row?.platformFee ?? 0),
    orders: Number(row?.orders ?? 0),
  }
}
