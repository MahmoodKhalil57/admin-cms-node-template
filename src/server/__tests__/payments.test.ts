import { describe, expect, test } from 'bun:test'

import { stripe, stripeSignatureHeader } from '../payments/stripe'
import type { ProviderConfig } from '../payments/provider'

/**
 * The money layer's two dangerous questions.
 *
 * *Did this really come from Stripe?* — because the webhook is the only thing
 * that marks an order paid, so anybody who can forge one can take the shop's
 * stock for free.
 *
 * *Have I already acted on this?* — because providers retry, and the symptom of
 * getting it wrong is a buyer charged once and fulfilled twice. That half is
 * enforced by a unique index, so it is tested against the database in the live
 * checks rather than here; what is here is everything that decides whether the
 * event is believed at all.
 */

const config: ProviderConfig = {
  secretKey: 'sk_test_not_a_real_key',
  webhookSecret: 'whsec_test_secret',
  currency: 'USD',
}

const NOW = 1_800_000_000

function paidEvent(reference = 'ord_abc', id = 'evt_1') {
  return JSON.stringify({
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        client_reference_id: reference,
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
      },
    },
  })
}

describe('believing a webhook', () => {
  test('a correctly signed event is accepted', async () => {
    const body = paidEvent()
    const header = await stripeSignatureHeader(config.webhookSecret, body, NOW)
    const event = await stripe.verify(config, body, header, NOW)
    expect(event).not.toBeNull()
    expect(event!.id).toBe('evt_1')
    expect(event!.type).toBe('checkout.session.completed')
  })

  test('a missing signature is refused', async () => {
    expect(await stripe.verify(config, paidEvent(), null, NOW)).toBeNull()
  })

  test('a signature from the wrong secret is refused', async () => {
    const body = paidEvent()
    const header = await stripeSignatureHeader('whsec_someone_else', body, NOW)
    expect(await stripe.verify(config, body, header, NOW)).toBeNull()
  })

  test('a body changed after signing is refused', async () => {
    // The attack this actually stops: a real event, with the amount edited.
    const body = paidEvent()
    const header = await stripeSignatureHeader(config.webhookSecret, body, NOW)
    const tampered = body.replace('ord_abc', 'ord_xyz')
    expect(await stripe.verify(config, tampered, header, NOW)).toBeNull()
  })

  test('an old signature is refused, however valid', async () => {
    // A genuine webhook, recorded and sent again tomorrow.
    const body = paidEvent()
    const header = await stripeSignatureHeader(config.webhookSecret, body, NOW)
    expect(await stripe.verify(config, body, header, NOW + 3600)).toBeNull()
  })

  test('a signature from the near future is accepted', async () => {
    // Clocks drift. Rejecting a few seconds either way would drop real events.
    const body = paidEvent()
    const header = await stripeSignatureHeader(config.webhookSecret, body, NOW + 30)
    expect(await stripe.verify(config, body, header, NOW)).not.toBeNull()
  })

  test('more than one signature is accepted while a secret rotates', async () => {
    const body = paidEvent()
    const mine = await stripeSignatureHeader(config.webhookSecret, body, NOW)
    const other = await stripeSignatureHeader('whsec_old', body, NOW)
    const both = `${other},${mine.split(',')[1]}`
    expect(await stripe.verify(config, body, both, NOW)).not.toBeNull()
  })

  test('a node with no webhook secret believes nothing', async () => {
    const body = paidEvent()
    const header = await stripeSignatureHeader(config.webhookSecret, body, NOW)
    expect(
      await stripe.verify({ ...config, webhookSecret: '' }, body, header, NOW),
    ).toBeNull()
  })

  test('a signed body that is not JSON is refused', async () => {
    const body = 'not json'
    const header = await stripeSignatureHeader(config.webhookSecret, body, NOW)
    expect(await stripe.verify(config, body, header, NOW)).toBeNull()
  })
})

describe('what an event means', () => {
  const event = (type: string, object: Record<string, unknown>) => ({
    id: 'evt_x',
    type,
    payload: { id: 'evt_x', type, data: { object } },
  })

  test('a completed, paid session pays the order', () => {
    expect(
      stripe.interpret(
        event('checkout.session.completed', {
          client_reference_id: 'ord_abc',
          payment_status: 'paid',
          payment_intent: 'pi_1',
        }),
      ),
    ).toEqual({ reference: 'ord_abc', status: 'paid', paymentIntentId: 'pi_1' })
  })

  test('a completed session that is not paid does nothing', () => {
    // A bank debit can complete the session and settle days later. Treating
    // this as paid ships the goods before the money exists.
    expect(
      stripe.interpret(
        event('checkout.session.completed', {
          client_reference_id: 'ord_abc',
          payment_status: 'unpaid',
        }),
      ),
    ).toBeNull()
  })

  test('a later success on a delayed method pays it', () => {
    expect(
      stripe.interpret(
        event('checkout.session.async_payment_succeeded', {
          client_reference_id: 'ord_abc',
        }),
      ),
    ).toMatchObject({ reference: 'ord_abc', status: 'paid' })
  })

  test('an expired session fails the order', () => {
    expect(
      stripe.interpret(
        event('checkout.session.expired', { client_reference_id: 'ord_abc' }),
      ),
    ).toMatchObject({ reference: 'ord_abc', status: 'failed' })
  })

  test('a refund carries its amount', () => {
    expect(
      stripe.interpret(
        event('charge.refunded', {
          metadata: { reference: 'ord_abc' },
          amount_refunded: 500,
        }),
      ),
    ).toEqual({ reference: 'ord_abc', status: 'refunded', refunded: 500 })
  })

  test('an event about somebody else’s concerns is ignored', () => {
    expect(
      stripe.interpret(event('customer.subscription.updated', { id: 'sub_1' })),
    ).toBeNull()
  })

  test('an event with no reference cannot be placed', () => {
    // Rather than guessing which order it meant.
    expect(
      stripe.interpret(
        event('checkout.session.completed', { payment_status: 'paid' }),
      ),
    ).toBeNull()
  })
})
