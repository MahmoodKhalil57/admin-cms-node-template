import type { ProviderConfig } from '../payments/provider'

/**
 * Stripe Connect, the part that moves money to somebody else.
 *
 * A standard Stripe account can only pay out to its own bank accounts. This is
 * the mechanism that pays a stranger's, and there is no alternative that is not
 * either this or doing bank transfers ourselves — which is a regulated activity
 * and firmly not the business.
 *
 * Two things are called a payout and they are on different clocks:
 *
 *   transfer — platform balance → the vendor's connected account
 *   payout   — connected account → the vendor's bank
 *
 * A withdrawal is both, in that order, in one action. The connected account is
 * created on a *manual* schedule so Stripe never moves money on its own and
 * "how often" stays the vendor's decision rather than a platform default.
 */

const API = 'https://api.stripe.com/v1'

async function call(
  config: ProviderConfig,
  path: string,
  body?: URLSearchParams,
  options: { idempotencyKey?: string; onBehalfOf?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(options.idempotencyKey
        ? { 'Idempotency-Key': options.idempotencyKey }
        : {}),
      // Acting as the connected account, which is how a payout to their bank
      // is created without them ever giving us a credential.
      ...(options.onBehalfOf ? { 'Stripe-Account': options.onBehalfOf } : {}),
    },
    body,
  })

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const error = (json.error ?? {}) as { message?: string }
    throw new Error(error.message ?? `Stripe refused that (${response.status}).`)
  }
  return json
}

/** An Express account: Stripe hosts the onboarding and owns the identity checks. */
export async function createAccount(
  config: ProviderConfig,
  vendor: { email?: string | null; name: string },
): Promise<string> {
  const body = new URLSearchParams({
    type: 'express',
    'capabilities[transfers][requested]': 'true',
    'business_profile[name]': vendor.name,
    // Manual, so nothing leaves without the vendor asking. The whole design
    // rests on this line.
    'settings[payouts][schedule][interval]': 'manual',
  })
  if (vendor.email) body.set('email', vendor.email)

  const account = await call(config, '/accounts', body)
  return String(account.id)
}

/**
 * A one-time link to Stripe's onboarding.
 *
 * Short-lived and single-use by Stripe's design, which is why it is generated on
 * demand rather than stored. The bank details are entered on their page; this
 * node never sees them.
 */
export async function onboardingLink(
  config: ProviderConfig,
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<string> {
  const link = await call(
    config,
    '/account_links',
    new URLSearchParams({
      account: accountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: refreshUrl,
    }),
  )
  return String(link.url)
}

export interface AccountState {
  payoutsEnabled: boolean
  status: 'none' | 'pending' | 'restricted' | 'ready'
}

/** What Stripe currently thinks of this account. Their answer, not ours. */
export async function accountState(
  config: ProviderConfig,
  accountId: string,
): Promise<AccountState> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const account = (await call(config, `/accounts/${accountId}`)) as any
  const payoutsEnabled = Boolean(account.payouts_enabled)
  const due = account.requirements?.currently_due ?? []
  const disabled = account.requirements?.disabled_reason

  return {
    payoutsEnabled,
    status: payoutsEnabled
      ? 'ready'
      : disabled
        ? 'restricted'
        : due.length
          ? 'pending'
          : 'pending',
  }
}

/** Platform balance → connected account. */
export async function createTransfer(
  config: ProviderConfig,
  input: {
    accountId: string
    amount: number
    currency: string
    idempotencyKey: string
    transferGroup?: string | null
  },
): Promise<string> {
  const body = new URLSearchParams({
    destination: input.accountId,
    amount: String(input.amount),
    currency: input.currency.toLowerCase(),
  })
  if (input.transferGroup) body.set('transfer_group', input.transferGroup)

  const transfer = await call(config, '/transfers', body, {
    idempotencyKey: input.idempotencyKey,
  })
  return String(transfer.id)
}

/** Connected account → their bank, created as them. */
export async function createPayout(
  config: ProviderConfig,
  input: {
    accountId: string
    amount: number
    currency: string
    idempotencyKey: string
  },
): Promise<string> {
  const payout = await call(
    config,
    '/payouts',
    new URLSearchParams({
      amount: String(input.amount),
      currency: input.currency.toLowerCase(),
    }),
    { idempotencyKey: input.idempotencyKey, onBehalfOf: input.accountId },
  )
  return String(payout.id)
}

/**
 * What the platform can actually send right now.
 *
 * Card money settles on a delay, so a balance that a vendor has earned is not
 * the same as one the platform holds. Transferring more than is available fails
 * at Stripe with a message a vendor cannot act on, so it is checked here first.
 */
export async function availableBalance(
  config: ProviderConfig,
  currency: string,
): Promise<number> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const balance = (await call(config, '/balance')) as any
  const entry = (balance.available ?? []).find(
    (row: any) => String(row.currency).toLowerCase() === currency.toLowerCase(),
  )
  return Number(entry?.amount ?? 0)
}

/** The fee the provider actually charged, once it is known. */
export async function payoutFee(
  config: ProviderConfig,
  accountId: string,
  payoutId: string,
): Promise<number | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  try {
    const payout = (await call(
      config,
      `/payouts/${payoutId}`,
      undefined,
      { onBehalfOf: accountId },
    )) as any
    if (!payout.balance_transaction) return null
    const transaction = (await call(
      config,
      `/balance_transactions/${payout.balance_transaction}`,
      undefined,
      { onBehalfOf: accountId },
    )) as any
    return Number(transaction.fee ?? 0)
  } catch {
    return null
  }
}
