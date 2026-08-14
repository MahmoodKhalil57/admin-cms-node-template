import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { paymentProviders, payouts, vendors } from '#/db/schema'
import type { NodeEnv } from '../env'
import { record } from '../events'
import { providerConfig } from '../payments/orders'
import { availableBalance, createPayout, createTransfer, payoutFee } from './connect'
import { balanceOf, post, quote } from './ledger'
import type { FeeTerms, Quote } from './ledger'

/**
 * Taking money out, when the vendor decides to.
 *
 * The whole flow in one place because it has to be one decision: what is owed,
 * what the provider will charge, what is actually available to send, and
 * whether this is the second click on the same button.
 */

export async function feeTerms(db: NodeDb): Promise<FeeTerms & { currency: string }> {
  const [row] = await db.select().from(paymentProviders).limit(1)
  return {
    fixed: row?.payoutFeeFixed ?? 0,
    basisPoints: row?.payoutFeeBasisPoints ?? 0,
    minimum: row?.payoutMinimum ?? 0,
    currency: row?.currency ?? 'USD',
  }
}

export interface Standing {
  currency: string
  /** what the ledger says they are owed */
  balance: number
  /** what they could take right now, once settlement is considered */
  withdrawable: number
  quote: Quote
  payoutsEnabled: boolean
  onboardingStatus: string
  /** why nothing can be taken, when nothing can */
  blocked?: string
}

/**
 * What a vendor can take out at this moment.
 *
 * `withdrawable` is the lesser of what they are owed and what the platform
 * actually holds — card money settles on a delay, so a balance earned over a
 * busy weekend is not money that can be sent on Monday. Quoting from the ledger
 * alone would show a figure that fails at the provider with a message the
 * vendor cannot act on.
 */
export async function standingFor(
  env: NodeEnv,
  db: NodeDb,
  vendorId: number,
): Promise<Standing> {
  const terms = await feeTerms(db)
  const [vendor] = await db
    .select()
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1)

  const balance = await balanceOf(db, vendorId)
  let withdrawable = Math.max(0, balance)
  let blocked: string | undefined

  if (!vendor?.stripeAccountId) {
    blocked = 'Set up payouts to withdraw. Your balance is safe until you do.'
  } else if (!vendor.payoutsEnabled) {
    blocked = 'The payment provider has not finished checking this account yet.'
  }

  const found = await providerConfig(env, db)
  if (found && !blocked) {
    try {
      const settled = await availableBalance(found.config, terms.currency)
      if (settled < withdrawable) {
        withdrawable = Math.max(0, settled)
        if (withdrawable < balance) {
          blocked =
            withdrawable > 0
              ? 'Some of this is still settling and can be taken shortly.'
              : 'These sales are still settling. Try again shortly.'
        }
      }
    } catch {
      /* The provider is unreachable; quote from the ledger and let the
         withdrawal itself fail with the real reason. */
    }
  }

  return {
    currency: terms.currency,
    balance,
    withdrawable,
    quote: quote(withdrawable, terms),
    payoutsEnabled: Boolean(vendor?.payoutsEnabled),
    onboardingStatus: vendor?.onboardingStatus ?? 'none',
    blocked,
  }
}

export interface WithdrawResult {
  ok: boolean
  error?: string
  payoutId?: number
  gross?: number
  fee?: number
  net?: number
}

/**
 * Takes it.
 *
 * The row is written before the provider is called, with a key derived from the
 * vendor and the amount — so a double-click finds the unique index in its way
 * rather than creating a second transfer. The ledger is posted only once the
 * transfer succeeds: a balance reduced for money that never moved is worse than
 * a balance that is briefly optimistic.
 */
export async function withdraw(
  env: NodeEnv,
  db: NodeDb,
  vendorId: number,
  requested?: number,
): Promise<WithdrawResult> {
  const found = await providerConfig(env, db)
  if (!found) return { ok: false, error: 'Payouts are not set up on this node.' }

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1)
  if (!vendor?.stripeAccountId) {
    return { ok: false, error: 'This vendor has not set up payouts.' }
  }
  if (!vendor.payoutsEnabled) {
    return { ok: false, error: 'The provider has not enabled payouts yet.' }
  }

  const standing = await standingFor(env, db, vendorId)
  const gross = Math.min(
    requested && requested > 0 ? requested : standing.withdrawable,
    standing.withdrawable,
  )
  const terms = await feeTerms(db)
  const priced = quote(gross, terms)
  if (priced.refusal) return { ok: false, error: priced.refusal }

  // One per vendor, amount and minute. A second click inside that window is the
  // same intent; a genuine second withdrawal a minute later is a new one.
  const minute = Math.floor(Date.now() / 60_000)
  const idempotencyKey = `wd:${vendorId}:${gross}:${minute}`

  let row
  try {
    ;[row] = await db
      .insert(payouts)
      .values({
        vendorId,
        currency: priced.gross > 0 ? standing.currency : standing.currency,
        gross: priced.gross,
        feeEstimate: priced.fee,
        net: priced.net,
        status: 'pending',
        idempotencyKey,
      })
      .returning()
  } catch {
    return { ok: false, error: 'That withdrawal is already being processed.' }
  }
  if (!row) return { ok: false, error: 'Could not start that withdrawal.' }

  try {
    const transferId = await createTransfer(found.config, {
      accountId: vendor.stripeAccountId,
      amount: priced.net,
      currency: standing.currency,
      idempotencyKey: `${idempotencyKey}:transfer`,
    })

    // The ledger only after the money has moved.
    await post(db, {
      vendorId,
      kind: 'withdrawal',
      amount: -priced.net,
      currency: standing.currency,
      payoutId: row.id,
      dedupeKey: `withdrawal:${row.id}`,
      note: 'Withdrawal',
    })
    await post(db, {
      vendorId,
      kind: 'fee',
      amount: -priced.fee,
      currency: standing.currency,
      payoutId: row.id,
      dedupeKey: `fee:${row.id}`,
      note: 'Withdrawal fee',
    })

    // Their bank. A failure here leaves the money on their connected account
    // rather than lost, which is why it does not undo the transfer.
    let providerPayoutId: string | null = null
    try {
      providerPayoutId = await createPayout(found.config, {
        accountId: vendor.stripeAccountId,
        amount: priced.net,
        currency: standing.currency,
        idempotencyKey: `${idempotencyKey}:payout`,
      })
    } catch {
      /* Left for the provider's own schedule or a later retry. */
    }

    await db
      .update(payouts)
      .set({ transferId, providerPayoutId, status: 'paid' })
      .where(eq(payouts.id, row.id))

    await record(db, {
      name: 'vendor.withdrew',
      vendorId,
      subjectType: 'payouts',
      subjectId: row.id,
      detail: { gross: priced.gross, fee: priced.fee, net: priced.net },
    })

    return {
      ok: true,
      payoutId: row.id,
      gross: priced.gross,
      fee: priced.fee,
      net: priced.net,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Transfer failed.'
    await db
      .update(payouts)
      .set({ status: 'failed', failureReason: reason })
      .where(eq(payouts.id, row.id))
    // Nothing was posted, so the balance is untouched and they may try again.
    return { ok: false, error: reason }
  }
}

/**
 * Writes back what the provider actually charged.
 *
 * The quote was an estimate from a formula rootAdmin configured; this is the
 * real number, and the difference is posted so the ledger ends up agreeing with
 * the bank rather than with the formula. Called on demand today — the tidier
 * trigger is a `payout.paid` webhook on the connected account, which needs
 * Connect webhooks configured.
 */
export async function reconcile(
  env: NodeEnv,
  db: NodeDb,
  payoutRowId: number,
): Promise<number | null> {
  const found = await providerConfig(env, db)
  if (!found) return null

  const [row] = await db
    .select()
    .from(payouts)
    .where(eq(payouts.id, payoutRowId))
    .limit(1)
  if (!row?.providerPayoutId || row.feeActual !== null) return null

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(eq(vendors.id, row.vendorId))
    .limit(1)
  if (!vendor?.stripeAccountId) return null

  const actual = await payoutFee(
    found.config,
    vendor.stripeAccountId,
    row.providerPayoutId,
  )
  if (actual === null) return null

  await db
    .update(payouts)
    .set({ feeActual: actual })
    .where(eq(payouts.id, row.id))

  const difference = row.feeEstimate - actual
  if (difference !== 0) {
    await post(db, {
      vendorId: row.vendorId,
      kind: 'adjustment',
      amount: difference,
      currency: row.currency,
      payoutId: row.id,
      dedupeKey: `truing:${row.id}`,
      note:
        difference > 0
          ? 'Withdrawal fee was lower than quoted'
          : 'Withdrawal fee was higher than quoted',
    })
  }

  return actual
}
