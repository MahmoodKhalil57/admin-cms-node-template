import { inArray } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { settings as settingsTable, vendors } from '#/db/schema'

/**
 * What the platform keeps, and what the vendor is owed.
 *
 * This is the piece that turns a shop into a marketplace. Everything else about
 * feature 2 already existed — vendors own their rows, buyers pay, vendors
 * withdraw — but every sale credited the vendor the whole line and the operator
 * nothing, which is a marketplace that costs its owner money to run.
 *
 * Two rules, both deliberate:
 *
 * **Basis points, and the arithmetic stays integer the whole way.** A rate of
 * 12.5% is 1250, and a share of 1999 is `1999 * 1250 / 10000` — computed as one
 * multiplication and one division, in that order, so the intermediate is exact.
 * Reaching for 0.125 anywhere in here would reintroduce the float that every
 * other money column in this schema exists to avoid.
 *
 * **The remainder goes to the vendor.** The fee is rounded down, so a rate of
 * 10% on 1999 takes 199 rather than 200. Withdrawal fees round the other way,
 * and the difference is not an inconsistency: a withdrawal fee covers something
 * Stripe will really charge us, so under-withholding leaves a hole, while a
 * commission is the operator's own cut and taking a fraction more than the
 * published rate is a small dishonesty repeated on every sale.
 */

/** The most anybody can be charged. Not a policy — an arithmetic guard. */
export const MAX_COMMISSION_BPS = 10_000

export interface Split {
  vendorShare: number
  platformFee: number
  /** what was applied, so a caller can say why */
  bps: number
}

export function splitLine(amount: number, bps: number): Split {
  const rate = Math.min(Math.max(Math.trunc(bps) || 0, 0), MAX_COMMISSION_BPS)
  // A line with no vendor behind it belongs entirely to the platform, and the
  // caller decides that by not asking. Here, a negative amount cannot happen
  // and would produce nonsense if it did, so it is clamped rather than trusted.
  const total = Math.max(Math.trunc(amount) || 0, 0)
  const platformFee = Math.floor((total * rate) / MAX_COMMISSION_BPS)
  return { vendorShare: total - platformFee, platformFee, bps: rate }
}

/**
 * The rate for each vendor named, falling back to the node's.
 *
 * One query for the vendors and one for the node, however many lines the cart
 * has — a checkout that read the rate per line would do a round trip per item
 * for an answer that cannot change mid-cart.
 *
 * A vendor's own rate of `null` is not zero. Null means "whatever the node
 * charges", which is what almost every vendor should be, and zero means "this
 * one sells here for free" — a real thing an operator might mean and would be
 * unable to say if null meant it.
 */
export async function commissionRates(
  db: NodeDb,
  vendorIds: Array<number>,
): Promise<{ nodeBps: number; forVendor: (id: number | null) => number }> {
  const [row] = await db.select().from(settingsTable).limit(1)
  const nodeBps = row?.commissionBps ?? 0

  const wanted = [...new Set(vendorIds.filter((id): id is number => Boolean(id)))]
  const own = new Map<number, number | null>()
  if (wanted.length > 0) {
    const rows = await db
      .select({ id: vendors.id, bps: vendors.commissionBps })
      .from(vendors)
      .where(inArray(vendors.id, wanted))
    for (const vendor of rows) own.set(vendor.id, vendor.bps)
  }

  return {
    nodeBps,
    forVendor: (id) => {
      // No vendor means the platform is the seller, so there is nothing to take
      // a cut from and nobody to take it from.
      if (!id) return 0
      const mine = own.get(id)
      return mine === null || mine === undefined ? nodeBps : mine
    },
  }
}
