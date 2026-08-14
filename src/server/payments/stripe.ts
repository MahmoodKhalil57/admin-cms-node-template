import type {
  CheckoutRequest,
  CheckoutSession,
  OrderOutcome,
  PaymentProvider,
  ProviderConfig,
  VerifiedEvent,
} from './provider'

/**
 * Stripe, spoken to directly.
 *
 * No SDK. Stripe's official library is written for Node, pulls in a large
 * dependency tree, and would land in a Worker bundle that already had to be
 * rescued from one library that could not run in a browser. What it does for us
 * here is two things — form-encode a request and check an HMAC — and both are
 * shorter than the import.
 *
 * Checkout Sessions rather than PaymentIntents on our own page: the buyer types
 * their card on Stripe's domain, so no card number is ever in a request this
 * node serves. That is the difference between a node that has to think about
 * PCI scope and one that does not.
 */

const API = 'https://api.stripe.com/v1'

/** Stripe takes form bodies, including for nested structures. */
function form(values: Record<string, string | number | undefined | null>) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    body.set(key, String(value))
  }
  return body
}

async function call(
  config: ProviderConfig,
  path: string,
  body: URLSearchParams,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe replays the first response for a repeated key, so a retried
      // checkout creates one session rather than two.
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
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

/* --- signatures ----------------------------------------------------------- */

/**
 * Stripe signs `${timestamp}.${body}` with the endpoint's secret and sends it
 * as `t=…,v1=…`. Verifying means recomputing it over the *raw* body — which is
 * why the route reads text and parses afterwards, since re-serialising JSON
 * changes bytes and breaks the signature for reasons nobody enjoys finding.
 */
const TOLERANCE_SECONDS = 5 * 60

function parseSignature(header: string): { t: number; v1: Array<string> } {
  const parts = header.split(',').map((piece) => piece.trim())
  let t = 0
  const v1: Array<string> = []
  for (const part of parts) {
    const [scheme, value] = part.split('=')
    if (scheme === 't') t = Number(value)
    // More than one is normal while a secret is being rotated.
    if (scheme === 'v1' && value) v1.push(value)
  }
  return { t, v1 }
}

/** Constant time, so a wrong signature cannot be found one byte at a time. */
function sameBytes(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Exported for the tests, which have to be able to produce a real signature. */
export async function stripeSignatureHeader(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  return `t=${timestamp},v1=${await sign(secret, `${timestamp}.${body}`)}`
}

/* --- the provider --------------------------------------------------------- */

export const stripe: PaymentProvider = {
  key: 'stripe',
  label: 'Stripe',
  consoleUrl: 'https://dashboard.stripe.com/webhooks',

  async createCheckout(
    config: ProviderConfig,
    request: CheckoutRequest,
  ): Promise<CheckoutSession> {
    const body = form({
      mode: 'payment',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      customer_email: request.buyerEmail ?? undefined,
      // Handed back on every event about this payment, which is how a webhook
      // finds the order without trusting anything the browser said.
      client_reference_id: request.reference,
      'metadata[reference]': request.reference,
      'payment_intent_data[transfer_group]': request.transferGroup,
      'payment_intent_data[metadata][reference]': request.reference,
    })

    request.lines.forEach((line, index) => {
      body.set(`line_items[${index}][quantity]`, String(line.quantity))
      body.set(
        `line_items[${index}][price_data][currency]`,
        request.currency.toLowerCase(),
      )
      body.set(
        `line_items[${index}][price_data][unit_amount]`,
        String(line.unitAmount),
      )
      body.set(
        `line_items[${index}][price_data][product_data][name]`,
        line.name,
      )
    })

    const session = await call(
      config,
      '/checkout/sessions',
      body,
      // Our own reference: the same order never opens two sessions.
      `checkout:${request.reference}`,
    )
    return {
      url: String(session.url),
      providerRef: String(session.id),
    }
  },

  async verify(
    config: ProviderConfig,
    body: string,
    signature: string | null,
    now = Math.floor(Date.now() / 1000),
  ): Promise<VerifiedEvent | null> {
    if (!signature || !config.webhookSecret) return null

    const { t, v1 } = parseSignature(signature)
    if (!t || v1.length === 0) return null

    // Replay protection. A signature stays valid forever without this, so a
    // recording of one genuine webhook could be sent back at any time.
    if (Math.abs(now - t) > TOLERANCE_SECONDS) return null

    const expected = await sign(config.webhookSecret, `${t}.${body}`)
    if (!v1.some((candidate) => sameBytes(candidate, expected))) return null

    try {
      const event = JSON.parse(body) as Record<string, unknown>
      if (typeof event.id !== 'string' || typeof event.type !== 'string') {
        return null
      }
      return { id: event.id, type: event.type, payload: event }
    } catch {
      return null
    }
  },

  interpret(event: VerifiedEvent): OrderOutcome | null {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const object = ((event.payload as any)?.data?.object ?? {}) as any
    const reference =
      object.client_reference_id ??
      object.metadata?.reference ??
      object.payment_intent?.metadata?.reference ??
      null

    switch (event.type) {
      case 'checkout.session.completed':
        // `complete` means the session finished; `paid` means the money did.
        // A session can complete unpaid when the method settles later.
        if (object.payment_status !== 'paid') return null
        return reference
          ? {
              reference: String(reference),
              status: 'paid',
              paymentIntentId: object.payment_intent
                ? String(object.payment_intent)
                : null,
            }
          : null

      case 'checkout.session.async_payment_succeeded':
        return reference
          ? { reference: String(reference), status: 'paid' }
          : null

      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        return reference
          ? { reference: String(reference), status: 'failed' }
          : null

      case 'charge.refunded':
        return reference
          ? {
              reference: String(reference),
              status: 'refunded',
              refunded: Number(object.amount_refunded ?? 0),
            }
          : null

      default:
        // Most of what Stripe sends is none of our business, and saying so
        // quietly is the difference between a log and a noise generator.
        return null
    }
  },
}

export const PROVIDERS: Record<string, PaymentProvider> = { stripe }

export function providerFor(key: string): PaymentProvider | undefined {
  return PROVIDERS[key]
}
