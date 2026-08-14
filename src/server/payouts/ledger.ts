import { and, eq, sql } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { orderItems, vendorLedger } from '#/db/schema'

/**
 * A vendor's money, as a history rather than a number.
 *
 * Balance is the sum of the lines. Nothing writes a balance down, which means
 * nothing can write down a wrong one — and every figure a vendor is shown can
 * be traced to the sale, refund or withdrawal that produced it.
 *
 * Signed: positive is owed to the vendor, negative is taken away. That lets the
 * total go below zero, which is not a mistake but the point. A refund arriving
 * on a sale somebody already withdrew leaves them owing the platform, and there
 * is no way to take money back out of a bank account — so it has to be a number
 * the system carries into the next withdrawal.
 */

export type LedgerKind =
  | 'sale'
  | 'refund'
  | 'withdrawal'
  | 'fee'
  | 'adjustment'

export interface LedgerLine {
  vendorId: number
  kind: LedgerKind
  /** smallest unit, signed */
  amount: number
  currency: string
  orderItemId?: number | null
  payoutId?: number | null
  note?: string | null
  /** what makes this line unrepeatable; omit for lines that may recur */
  dedupeKey?: string | null
}

/**
 * Posts a line, once.
 *
 * The unique index on `dedupeKey` is the guarantee, not a check beforehand — a
 * webhook delivered twice posts the same key and the second insert is refused.
 * Returns whether it was new, because a caller that needs to know is asking a
 * real question and a caller that does not can ignore it.
 */
export async function post(db: NodeDb, line: LedgerLine): Promise<boolean> {
  try {
    await db.insert(vendorLedger).values({
      vendorId: line.vendorId,
      kind: line.kind,
      amount: line.amount,
      currency: line.currency,
      orderItemId: line.orderItemId ?? null,
      payoutId: line.payoutId ?? null,
      note: line.note ?? null,
      dedupeKey: line.dedupeKey ?? null,
    })
    return true
  } catch {
    return false
  }
}

export async function balanceOf(
  db: NodeDb,
  vendorId: number,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${vendorLedger.amount}), 0)` })
    .from(vendorLedger)
    .where(eq(vendorLedger.vendorId, vendorId))
  return Number(row?.total ?? 0)
}

/**
 * Credits every vendor on a paid order.
 *
 * Read from `order_items`, where the share was written at the moment of sale —
 * not recomputed from the product, which may since have changed price or
 * changed hands. A receipt and a ledger that disagree is worse than either.
 *
 * Lines with no vendor are skipped rather than posted to nobody: on a
 * single-vendor node the platform *is* the vendor, and inventing a row for it
 * would put money in a ledger nobody withdraws from.
 */
export async function creditSale(
  db: NodeDb,
  orderId: number,
  currency: string,
): Promise<void> {
  const lines = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))

  for (const line of lines) {
    if (!line.vendorId || line.vendorShare <= 0) continue
    await post(db, {
      vendorId: line.vendorId,
      kind: 'sale',
      amount: line.vendorShare,
      currency,
      orderItemId: line.id,
      dedupeKey: `sale:${line.id}`,
      note: line.name,
    })
  }
}

/**
 * Takes it back when the money goes back.
 *
 * In proportion, so a partial refund does not claw a whole sale. The vendor may
 * already have withdrawn it; that is precisely why the balance is allowed to go
 * negative rather than this being refused.
 */
export async function debitRefund(
  db: NodeDb,
  orderId: number,
  currency: string,
  refunded: number,
  orderTotal: number,
): Promise<void> {
  if (refunded <= 0 || orderTotal <= 0) return
  const lines = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))

  for (const line of lines) {
    if (!line.vendorId || line.vendorShare <= 0) continue
    // Rounded down, so the platform absorbs the rounding rather than the
    // vendor being debited a penny they were never credited.
    const share = Math.floor((line.vendorShare * refunded) / orderTotal)
    if (share <= 0) continue
    await post(db, {
      vendorId: line.vendorId,
      kind: 'refund',
      amount: -share,
      currency,
      orderItemId: line.id,
      // Keyed on the amount too: a second, larger refund on the same line is a
      // real event and must be able to post.
      dedupeKey: `refund:${line.id}:${refunded}`,
      note: `Refund of ${line.name}`,
    })
  }
}

/* --- fees ----------------------------------------------------------------- */

export interface FeeTerms {
  fixed: number
  basisPoints: number
  minimum: number
}

export interface Quote {
  gross: number
  fee: number
  net: number
  /** why this cannot be taken, when it cannot */
  refusal?: string
}

/**
 * What a withdrawal of this much would cost, and whether it is worth taking.
 *
 * Rounded up, deliberately. The fee is withheld to meet what the provider
 * charges the platform, and rounding it down leaves the platform a penny short
 * on every withdrawal — which is small, constant, and in the wrong direction.
 */
export function quote(gross: number, terms: FeeTerms): Quote {
  if (gross <= 0) {
    return { gross, fee: 0, net: 0, refusal: 'There is nothing to withdraw.' }
  }

  const fee = terms.fixed + Math.ceil((gross * terms.basisPoints) / 10_000)
  const net = gross - fee

  if (net <= 0) {
    return {
      gross,
      fee,
      net,
      refusal: 'That is smaller than the fee to send it.',
    }
  }
  if (terms.minimum > 0 && gross < terms.minimum) {
    return {
      gross,
      fee,
      net,
      refusal: `Withdrawals start at ${terms.minimum}.`,
    }
  }

  return { gross, fee, net }
}

/** Lines already posted against one payout, so a retry cannot post them twice. */
export async function payoutPosted(
  db: NodeDb,
  payoutId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: vendorLedger.id })
    .from(vendorLedger)
    .where(
      and(
        eq(vendorLedger.payoutId, payoutId),
        eq(vendorLedger.kind, 'withdrawal'),
      ),
    )
    .limit(1)
  return Boolean(row)
}
