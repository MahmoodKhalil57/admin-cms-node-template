import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { orderItems, orders, paymentEvents, paymentProviders } from '#/db/schema'
import type { NodeEnv } from '../env'
import { open } from '../secrets'
import { record } from '../events'
import { providerFor } from './stripe'
import type { OrderOutcome, ProviderConfig, VerifiedEvent } from './provider'

/**
 * An order's life, from asked-for to paid.
 *
 * The rule the whole file is arranged around: **the provider says whether money
 * moved, and nothing else does.** Not the browser arriving back on the success
 * page — a buyer who closes the tab has still paid, and a buyer who opens the
 * success URL directly has not. The return page reads status; the webhook sets
 * it.
 */

export interface Line {
  name: string
  unitAmount: number
  quantity: number
  vendorId?: number | null
  /** what the vendor is owed; defaults to the whole line on a single-vendor node */
  vendorShare?: number
  platformFee?: number
  subjectType?: string
  subjectId?: string
}

/** Unguessable, and short enough to read down a phone. */
export function newReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return `ord_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export async function providerConfig(
  env: NodeEnv,
  db: NodeDb,
): Promise<{ key: string; config: ProviderConfig } | null> {
  const [row] = await db.select().from(paymentProviders).limit(1)
  if (!row || !row.enabled) return null

  const secretKey = await open(env, row.secretKey)
  const webhookSecret = await open(env, row.webhookSecret)
  if (!secretKey) return null

  return {
    key: row.key,
    config: { secretKey, webhookSecret: webhookSecret ?? '', currency: row.currency },
  }
}

/**
 * Writes the order before anybody is sent anywhere.
 *
 * In this order on purpose: a session created without a row behind it is a
 * payment nobody can attribute, and that is unrecoverable. A row without a
 * session is an abandoned checkout, which is ordinary.
 */
export async function openOrder(
  db: NodeDb,
  input: {
    providerKey: string
    currency: string
    lines: Array<Line>
    buyerUserId?: string | null
    buyerEmail?: string | null
  },
): Promise<{ id: number; reference: string; transferGroup: string; total: number }> {
  const reference = newReference()
  const total = input.lines.reduce(
    (sum, line) => sum + line.unitAmount * line.quantity,
    0,
  )

  const [order] = await db
    .insert(orders)
    .values({
      reference,
      buyerUserId: input.buyerUserId ?? null,
      buyerEmail: input.buyerEmail ?? null,
      currency: input.currency.toUpperCase(),
      total,
      status: 'pending',
      providerKey: input.providerKey,
      // The group is the reference. One less thing to correlate later, and it
      // means a transfer can always be traced back to a single order.
      transferGroup: reference,
    })
    .returning()

  await db.insert(orderItems).values(
    input.lines.map((line) => {
      const amount = line.unitAmount * line.quantity
      return {
        orderId: order!.id,
        subjectType: line.subjectType ?? null,
        subjectId: line.subjectId ?? null,
        name: line.name,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        amount,
        vendorId: line.vendorId ?? null,
        // On a single-vendor node the vendor's share is the whole line, and
        // the platform's cut is zero. Written down either way so the ledger
        // has something to post from without a special case.
        vendorShare: line.vendorShare ?? amount,
        platformFee: line.platformFee ?? 0,
      }
    }),
  )

  void record(db, {
    name: 'order.created',
    subjectType: 'orders',
    subjectId: order!.id,
    detail: { reference, total, currency: order!.currency },
  })

  return {
    id: order!.id,
    reference,
    transferGroup: reference,
    total,
  }
}

export type Applied =
  /** seen before; the unique index refused the insert */
  | { outcome: 'duplicate' }
  /** a real event about something that is not our business */
  | { outcome: 'ignored' }
  /** understood, but it would have moved the order backwards */
  | { outcome: 'stale'; reference: string; status: string }
  | { outcome: 'applied'; reference: string; status: string }
  | { outcome: 'unknown-order'; reference: string }

/**
 * Records a webhook and applies it, once.
 *
 * The insert comes first and the unique index decides. A provider that retries
 * — and they all do — sends the same event id, the insert conflicts, and this
 * returns `duplicate` without touching the order. Checking for the row first
 * and then acting leaves a window between the two that a second delivery fits
 * into exactly, and the symptom is a buyer charged once and fulfilled twice.
 *
 * Every event is kept, including the ones that mean nothing to us. A payment
 * dispute six months from now is answered from this table or not at all.
 */
export async function applyEvent(
  db: NodeDb,
  providerKey: string,
  event: VerifiedEvent,
): Promise<Applied> {
  try {
    await db.insert(paymentEvents).values({
      providerKey,
      providerEventId: event.id,
      type: event.type,
      payload: event.payload,
    })
  } catch {
    // The unique index refused it. Seen before, so there is nothing to do —
    // and nothing to report as a failure either, because a retry succeeding
    // quietly is exactly what the provider is hoping for.
    return { outcome: 'duplicate' }
  }

  const provider = providerFor(providerKey)
  const outcome = provider?.interpret(event) ?? null
  if (!outcome) {
    await mark(db, event.id, 'ignored')
    return { outcome: 'ignored' }
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.reference, outcome.reference))
    .limit(1)

  if (!order) {
    await mark(db, event.id, 'unknown-order')
    return { outcome: 'unknown-order', reference: outcome.reference }
  }

  // Whether it actually moved matters to whoever is reading this back. An
  // event that arrived too late to mean anything is not a failure, but calling
  // it `applied` would send somebody looking for a change that never happened.
  const moved = await transition(db, order, outcome)
  const result = moved ? 'applied' : 'stale'
  await mark(db, event.id, `${result}:${outcome.status}`)
  return { outcome: result, reference: outcome.reference, status: outcome.status }
}

async function mark(
  db: NodeDb,
  eventId: string,
  result: string,
): Promise<void> {
  await db
    .update(paymentEvents)
    .set({ appliedAt: new Date(), result })
    .where(eq(paymentEvents.providerEventId, eventId))
}

/**
 * Moves an order, and refuses to move it backwards.
 *
 * Events arrive out of order. A `checkout.session.completed` delivered after a
 * `charge.refunded` must not turn a refunded order back into a paid one, and
 * the guard is here rather than in the caller because there is more than one
 * caller and only one right answer.
 */
async function transition(
  db: NodeDb,
  order: { id: number; reference: string; status: string; total: number },
  outcome: OrderOutcome,
): Promise<boolean> {
  if (outcome.status === 'paid') {
    if (order.status === 'paid' || order.status === 'refunded') return false
    await db
      .update(orders)
      .set({
        status: 'paid',
        paidAt: new Date(),
        paymentIntentId: outcome.paymentIntentId ?? null,
      })
      .where(eq(orders.id, order.id))

    void record(db, {
      name: 'order.paid',
      subjectType: 'orders',
      subjectId: order.id,
      detail: { reference: order.reference, total: order.total },
    })
    return true
  }

  if (outcome.status === 'failed') {
    // A failure after payment is not a failure of this order.
    if (order.status === 'paid' || order.status === 'refunded') return false
    await db.update(orders).set({ status: 'failed' }).where(eq(orders.id, order.id))
    void record(db, {
      name: 'order.failed',
      subjectType: 'orders',
      subjectId: order.id,
      detail: { reference: order.reference },
    })
    return true
  }

  if (outcome.status === 'refunded') {
    const refunded = outcome.refunded ?? order.total
    await db
      .update(orders)
      .set({
        refundedTotal: refunded,
        // Partly refunded is still a paid order; the amount says the rest.
        status: refunded >= order.total ? 'refunded' : order.status,
      })
      .where(eq(orders.id, order.id))

    void record(db, {
      name: 'order.refunded',
      subjectType: 'orders',
      subjectId: order.id,
      detail: { reference: order.reference, refunded },
    })
    return true
  }

  return false
}
