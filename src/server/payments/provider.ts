/**
 * What this node needs from anything that takes money.
 *
 * Deliberately small. Everything a payment provider does that is specific to it
 * — the shape of a checkout session, the way a signature is computed, what
 * their events are called — lives behind these four methods, so adding the
 * second provider is writing a file rather than finding every place the first
 * one leaked into.
 *
 * The seam is drawn where it is for one reason: the node never sees a card. A
 * provider is asked for a URL to send the buyer to, and afterwards it tells us
 * what happened. Nothing in between belongs here, and nothing in between is
 * something we should want to be responsible for.
 */

export interface ProviderConfig {
  secretKey: string
  webhookSecret: string
  currency: string
}

export interface CheckoutRequest {
  /** what the buyer is being charged, in the smallest unit */
  total: number
  currency: string
  lines: Array<{ name: string; unitAmount: number; quantity: number }>
  buyerEmail?: string | null
  /** this node's own order reference, handed back on every event */
  reference: string
  /** groups the charge for later transfers; see `orders.transferGroup` */
  transferGroup: string
  successUrl: string
  cancelUrl: string
}

export interface CheckoutSession {
  /** where to send the buyer */
  url: string
  /** the provider's id for this session, stored on the order */
  providerRef: string
}

/** A webhook that has been proven to come from the provider. */
export interface VerifiedEvent {
  /** the provider's id for this delivery — the idempotency key */
  id: string
  type: string
  payload: Record<string, unknown>
}

/**
 * What an event means to an order, in this node's vocabulary rather than the
 * provider's. Null for the many events that are none of our business.
 */
export interface OrderOutcome {
  /** this node's order reference, taken from the event */
  reference: string
  status: 'paid' | 'failed' | 'refunded'
  paymentIntentId?: string | null
  /** for a refund, the amount in the smallest unit */
  refunded?: number
}

export interface PaymentProvider {
  key: string
  label: string
  /** where rootAdmin goes to create the webhook, shown beside the field */
  consoleUrl: string
  createCheckout(
    config: ProviderConfig,
    request: CheckoutRequest,
  ): Promise<CheckoutSession>
  /**
   * Proves a request came from the provider, and returns null when it did not.
   * Never throws on a bad signature: a forged webhook is an ordinary thing to
   * receive on a public endpoint, not an exception.
   */
  verify(
    config: ProviderConfig,
    body: string,
    signature: string | null,
    now?: number,
  ): Promise<VerifiedEvent | null>
  /** What this event does to an order, if anything. */
  interpret(event: VerifiedEvent): OrderOutcome | null
}
