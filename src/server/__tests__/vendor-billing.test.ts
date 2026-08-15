import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { NodeDb } from '#/db'
import * as schema from '#/db/schema'
import { events, vendors } from '#/db/schema'
import {
  grantVendorCredits,
  meterVendors,
  runVendorMeter,
  vendorBalances,
} from '../vendor-billing'

/**
 * The node billing its own vendors.
 *
 * Feature 8 is feature 7 one level down, so these test the same two things
 * master's tests do — that usage is attributed to the right party and that a
 * period does not accumulate on re-reading — plus the one thing that is only
 * true at this level: the node's own activity must never land on a vendor's
 * bill, because master is already charging the node for it.
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

let db: NodeDb
let raw: Database

beforeEach(async () => {
  const made = freshDb()
  db = made.db
  raw = made.raw
  await db.insert(vendors).values([
    { slug: 'one', name: 'Vendor One' },
    { slug: 'two', name: 'Vendor Two' },
  ])
})

afterEach(() => raw.close())

const APRIL = new Date('2026-04-10T12:00:00Z')

async function log(name: string, vendorId: number | null, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await db.insert(events).values({ name, vendorId, createdAt: APRIL, detail: {} })
  }
}

describe('metering vendors', () => {
  test('each vendor is charged for their own', async () => {
    await log('vendor.sale', 1, 3)
    await log('vendor.sale', 2, 1)
    await log('submission.created', 1, 2)

    const readings = await meterVendors(db, '2026-04')
    const one = readings.find((row) => row.vendorId === 1)!
    const two = readings.find((row) => row.vendorId === 2)!
    // 3 orders at 5 + 2 submissions at 1.
    expect(one.credits).toBe(17)
    expect(two.credits).toBe(5)
  })

  test("the node's own activity is nobody's vendor bill", async () => {
    // The bit that only matters at this level. An event with no vendor is the
    // node's, and master is already charging the node for it — putting it on a
    // vendor would bill the same act to two people.
    await log('vendor.sale', null, 10)
    const readings = await meterVendors(db, '2026-04')
    expect(readings.length).toBe(0)
  })

  test('running the meter twice does not double the bill', async () => {
    await log('vendor.sale', 1, 3)
    await runVendorMeter(db, '2026-04')
    await runVendorMeter(db, '2026-04')
    await runVendorMeter(db, '2026-04')
    const [one] = await vendorBalances(db, [1])
    expect(one!.used).toBe(15)
  })

  test('a month with nothing in it costs nothing', async () => {
    await log('vendor.sale', 1, 3)
    await runVendorMeter(db, '2026-05')
    const [one] = await vendorBalances(db, [1])
    expect(one!.used).toBe(0)
  })
})

describe('the vendor balance', () => {
  test('is credits bought minus credits used', async () => {
    await log('vendor.sale', 1, 2)
    await runVendorMeter(db, '2026-04')
    await grantVendorCredits(db, { vendorId: 1, kind: 'grant', credits: 100 })
    const [one] = await vendorBalances(db, [1])
    expect(one).toMatchObject({ purchased: 100, used: 10, balance: 90 })
  })

  test('may go below zero without anything stopping', async () => {
    await log('vendor.sale', 1, 4)
    await runVendorMeter(db, '2026-04')
    expect((await vendorBalances(db, [1]))[0]!.balance).toBe(-20)
  })

  test('a purchase keyed on an order line is granted once', async () => {
    // The key a paid checkout posts, so a retried payment webhook grants once
    // — the same guarantee that stops it minting two download rights.
    const first = await grantVendorCredits(db, {
      vendorId: 1,
      kind: 'purchase',
      credits: 500,
      dedupeKey: 'order-item:42',
    })
    const second = await grantVendorCredits(db, {
      vendorId: 1,
      kind: 'purchase',
      credits: 500,
      dedupeKey: 'order-item:42',
    })
    expect([first, second]).toEqual([true, false])
    expect((await vendorBalances(db, [1]))[0]!.purchased).toBe(500)
  })

  test('a vendor asking only ever sees their own', async () => {
    await log('vendor.sale', 1, 1)
    await log('vendor.sale', 2, 9)
    await runVendorMeter(db, '2026-04')
    const mine = await vendorBalances(db, [1])
    expect(mine.length).toBe(1)
    expect(mine[0]!.used).toBe(5)
  })
})

describe('who pays for what', () => {
  test('a vendor is billed for their sale, the node for the order', async () => {
    // The two meters read one price list and take different halves. Processing
    // an order is the platform's service to the node; making a sale is the
    // node's service to the vendor. Billing both for one item would charge one
    // of them for the other's service.
    await log('order.paid', null, 1)
    await log('vendor.sale', 1, 2)

    const readings = await meterVendors(db, '2026-04')
    const one = readings.find((row) => row.vendorId === 1)!
    // Two sales at 5, and nothing for the order — that is the node's.
    expect(one.credits).toBe(10)
    expect(one.lines.find((line) => line.item === 'order')).toBeUndefined()
    expect(one.lines.find((line) => line.item === 'vendor-sale')!.quantity).toBe(2)
  })

  test('the node is not billed for a vendor sale', async () => {
    const { meter } = await import('../meter')
    await log('vendor.sale', 1, 4)
    const reading = await meter(
      { MEDIA: undefined } as never,
      db,
      '2026-04',
    )
    expect(reading.lines.find((line) => line.item === 'vendor-sale')).toBeUndefined()
    expect(reading.credits).toBe(0)
  })

  test('a shared item lands on both bills', async () => {
    // An enquiry costs the node to receive and costs the vendor it was about.
    await log('submission.created', 1, 3)
    const readings = await meterVendors(db, '2026-04')
    expect(readings[0]!.lines.find((l) => l.item === 'submission')!.quantity).toBe(3)

    const { meter } = await import('../meter')
    const node = await meter({ MEDIA: undefined } as never, db, '2026-04')
    expect(node.lines.find((l) => l.item === 'submission')!.quantity).toBe(3)
  })
})
