import { and, count, eq, gte, inArray, isNotNull, lt, notInArray, sql, sum } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  events,
  vendorCredits,
  vendorMeters,
  vendorPackages,
  vendors,
} from '#/db/schema'
import { PRICE_LIST, PRICE_LIST_VERSION, creditsFor, itemsFor, periodOf } from '#/lib/price-list'
import { boundsOf } from './meter'

/**
 * The node billing its own vendors.
 *
 * Feature 8, and it is feature 7 with a different biller at the top rather than
 * a second system. The shapes are deliberately the same as master's — a meter
 * that is replaced, a ledger that is appended to, a balance that is the
 * difference — so that somebody who has understood one has understood both.
 *
 * Three things genuinely differ, and all three follow from *who* is billing:
 *
 * 1. **The counting is per vendor**, which the event log can already answer
 *    because every event carries a `vendorId`. No new sensors.
 * 2. **The money is the operator's**, taken through the provider they already
 *    configured to sell to their own customers — so a vendor buying credits is
 *    an ordinary order, granted by the same webhook that has already been shown
 *    not to double-fulfil.
 * 3. **The prices are the operator's too.** They may charge their vendors
 *    nothing, or several times what the platform charges them. That is their
 *    margin; it is why this stores credits rather than money, exactly as the
 *    level above does.
 */

export interface VendorReading {
  vendorId: number
  period: string
  lines: Array<{ item: string; quantity: number; credits: number }>
  credits: number
}

/**
 * Meters every vendor for a period, from the event log.
 *
 * One grouped query for all of them rather than one per vendor: a marketplace
 * with fifty vendors would otherwise be fifty round trips for an answer the
 * database can give in one.
 *
 * Only the counted items. A vendor has no storage of their own to measure —
 * the bucket belongs to the node — so charging them for it would be charging
 * for something nothing attributes to them.
 */
export async function meterVendors(
  db: NodeDb,
  period = periodOf(),
): Promise<Array<VendorReading>> {
  const { from, to } = boundsOf(period)

  const rows = await db
    .select({
      vendorId: events.vendorId,
      name: events.name,
      total: count(),
    })
    .from(events)
    .where(
      and(
        gte(events.createdAt, from),
        lt(events.createdAt, to),
        // Events with no vendor are the node's own and are billed to the node
        // by master. Charging a vendor for them would bill the same act twice.
        isNotNull(events.vendorId),
      ),
    )
    .groupBy(events.vendorId, events.name)

  const byVendor = new Map<number, Map<string, number>>()
  for (const row of rows) {
    if (!row.vendorId) continue
    const counts = byVendor.get(row.vendorId) ?? new Map()
    counts.set(row.name, Number(row.total))
    byVendor.set(row.vendorId, counts)
  }

  const readings: Array<VendorReading> = []
  for (const [vendorId, counts] of byVendor) {
    const lines = itemsFor('vendor')
      .filter((item) => item.source === 'events')
      .map(
      (item) => {
        const quantity = counts.get(item.eventName ?? '') ?? 0
        return { item: item.key, quantity, credits: creditsFor(item, quantity) }
      })
    readings.push({
      vendorId,
      period,
      lines,
      credits: lines.reduce((total, line) => total + line.credits, 0),
    })
  }
  return readings
}

/**
 * Stores a reading, replacing the period rather than adding to it.
 *
 * The same guarantee as master's, for the same reason and with the same
 * correction: a period is a complete statement, so an item the reading no
 * longer mentions loses its row. Without that, an item dropped from the price
 * list keeps being billed forever.
 */
export async function storeVendorUsage(
  db: NodeDb,
  reading: VendorReading,
): Promise<number> {
  const seen: Array<string> = []
  for (const line of reading.lines) {
    const values = {
      vendorId: reading.vendorId,
      period: reading.period,
      item: line.item,
      quantity: Math.max(Math.trunc(line.quantity) || 0, 0),
      credits: Math.max(Math.trunc(line.credits) || 0, 0),
      priceListVersion: PRICE_LIST_VERSION,
      reportedAt: new Date(),
    }
    await db
      .insert(vendorMeters)
      .values(values)
      .onConflictDoUpdate({
        target: [vendorMeters.vendorId, vendorMeters.period, vendorMeters.item],
        set: {
          quantity: values.quantity,
          credits: values.credits,
          priceListVersion: values.priceListVersion,
          reportedAt: values.reportedAt,
        },
      })
    seen.push(line.item)
  }

  await db
    .delete(vendorMeters)
    .where(
      and(
        eq(vendorMeters.vendorId, reading.vendorId),
        eq(vendorMeters.period, reading.period),
        seen.length > 0 ? notInArray(vendorMeters.item, seen) : undefined,
      ),
    )

  return reading.credits
}

/** Meters and stores every vendor for the current period. */
export async function runVendorMeter(db: NodeDb, period = periodOf()): Promise<number> {
  const readings = await meterVendors(db, period)
  for (const reading of readings) await storeVendorUsage(db, reading)
  return readings.length
}

export interface VendorBalance {
  vendorId: number
  name: string
  purchased: number
  used: number
  balance: number
}

export async function vendorBalances(
  db: NodeDb,
  only?: Array<number>,
): Promise<Array<VendorBalance>> {
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(only && only.length > 0 ? inArray(vendors.id, only) : undefined)
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)

  const used = new Map(
    (
      await db
        .select({ vendorId: vendorMeters.vendorId, total: sum(vendorMeters.credits) })
        .from(vendorMeters)
        .where(inArray(vendorMeters.vendorId, ids))
        .groupBy(vendorMeters.vendorId)
    ).map((row) => [row.vendorId, Number(row.total ?? 0)]),
  )

  const put = new Map(
    (
      await db
        .select({ vendorId: vendorCredits.vendorId, total: sum(vendorCredits.credits) })
        .from(vendorCredits)
        .where(inArray(vendorCredits.vendorId, ids))
        .groupBy(vendorCredits.vendorId)
    ).map((row) => [row.vendorId, Number(row.total ?? 0)]),
  )

  return rows.map((row) => {
    const purchased = put.get(row.id) ?? 0
    const spent = used.get(row.id) ?? 0
    return {
      vendorId: row.id,
      name: row.name,
      purchased,
      used: spent,
      // Below zero for the same reason it is allowed a level up: billing must
      // not be the thing that stops a vendor selling.
      balance: purchased - spent,
    }
  })
}

/**
 * Puts credits in a vendor's account, once.
 *
 * The unique index on `dedupeKey` is the guarantee. Purchases key on the order
 * line, so a retried payment webhook grants once — the same discipline that
 * keeps the same webhook from minting two download entitlements.
 */
export async function grantVendorCredits(
  db: NodeDb,
  input: {
    vendorId: number
    kind: string
    credits: number
    amount?: number
    currency?: string
    note?: string
    dedupeKey?: string
  },
): Promise<boolean> {
  try {
    await db.insert(vendorCredits).values({
      vendorId: input.vendorId,
      kind: input.kind,
      credits: Math.trunc(input.credits),
      amount: Math.trunc(input.amount ?? 0),
      currency: input.currency ?? 'USD',
      note: input.note ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Three packages to start from, seeded once.
 *
 * Rows rather than code, unlike the price list, because what a vendor is *sold*
 * is a commercial decision the operator makes and changes without a deploy —
 * they may resell the platform's credits at a markup, at cost, or give them
 * away. Existing rows are never touched, so a price somebody set outlives the
 * next roll.
 */
const STARTER_PACKAGES = [
  {
    key: 'vendor-small',
    name: '500 credits',
    description: 'Enough for a quiet month.',
    credits: 500,
    price: 500,
    sortOrder: 0,
  },
  {
    key: 'vendor-medium',
    name: '2,500 credits',
    description: 'A working shop.',
    credits: 2500,
    price: 2000,
    sortOrder: 1,
  },
  {
    key: 'vendor-large',
    name: '10,000 credits',
    description: 'A busy one.',
    credits: 10_000,
    price: 7000,
    sortOrder: 2,
  },
]

export async function ensureVendorPackages(db: NodeDb): Promise<number> {
  const existing = await db.select({ key: vendorPackages.key }).from(vendorPackages)
  const known = new Set(existing.map((row) => row.key))
  const missing = STARTER_PACKAGES.filter((row) => !known.has(row.key))
  if (missing.length > 0) await db.insert(vendorPackages).values(missing)
  return missing.length
}

export async function packagesForVendors(db: NodeDb) {
  await ensureVendorPackages(db)
  return db
    .select()
    .from(vendorPackages)
    .where(eq(vendorPackages.active, true))
    .orderBy(vendorPackages.sortOrder)
}

export async function vendorPackageByKey(db: NodeDb, key: string) {
  const [row] = await db
    .select()
    .from(vendorPackages)
    .where(and(eq(vendorPackages.key, key), eq(vendorPackages.active, true)))
    .limit(1)
  return row ?? null
}

/** What one vendor used, period by period. */
export async function vendorUsage(db: NodeDb, vendorId: number) {
  const rows = await db
    .select()
    .from(vendorMeters)
    .where(eq(vendorMeters.vendorId, vendorId))
    .orderBy(sql`${vendorMeters.period} desc`)

  const byPeriod = new Map<string, { period: string; credits: number; lines: Array<{ item: string; name: string; quantity: number; credits: number }> }>()
  for (const row of rows) {
    const found = PRICE_LIST.find((item) => item.key === row.item)
    const bucket = byPeriod.get(row.period) ?? {
      period: row.period,
      credits: 0,
      lines: [],
    }
    bucket.credits += row.credits
    bucket.lines.push({
      item: row.item,
      name: found?.name ?? row.item,
      quantity: row.quantity,
      credits: row.credits,
    })
    byPeriod.set(row.period, bucket)
  }
  return [...byPeriod.values()]
}
