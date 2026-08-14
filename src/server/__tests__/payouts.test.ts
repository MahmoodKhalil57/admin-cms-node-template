import { describe, expect, test } from 'bun:test'

import { quote } from '../payouts/ledger'
import type { FeeTerms } from '../payouts/ledger'

/**
 * The fee arithmetic a vendor is shown before they agree to it.
 *
 * Worth testing away from everything else because it is the number the whole
 * change rests on. A fee that is a penny wrong in the platform's favour is a
 * slow theft; a penny wrong the other way is a slow leak. Neither shows up
 * anywhere until somebody adds up a year of them.
 */

const terms = (over: Partial<FeeTerms> = {}): FeeTerms => ({
  fixed: 25,
  basisPoints: 25,
  minimum: 0,
  ...over,
})

describe('quoting a withdrawal', () => {
  test('fixed plus a percentage, and the rest is theirs', () => {
    // 10.00 → 25 fixed + 0.25% of 1000 = 25 + 3 (rounded up) = 28
    const answer = quote(1000, terms())
    expect(answer.fee).toBe(28)
    expect(answer.net).toBe(972)
    expect(answer.fee + answer.net).toBe(answer.gross)
  })

  test('the fee and the net always add back to the gross', () => {
    // The property that matters: the ledger posts both lines, and if they do
    // not sum to what left the balance, the balance is wrong.
    for (const gross of [100, 999, 1000, 1234, 50_000, 999_999]) {
      const answer = quote(gross, terms())
      expect(answer.fee + answer.net).toBe(gross)
    }
  })

  test('the percentage rounds up, not down', () => {
    // 0.25% of 401 is 1.0025. Rounded down, the platform is a penny short on
    // every withdrawal — small, constant, and in the wrong direction.
    expect(quote(401, terms({ fixed: 0 })).fee).toBe(2)
  })

  test('a flat fee alone works', () => {
    expect(quote(1000, terms({ basisPoints: 0 }))).toMatchObject({
      fee: 25,
      net: 975,
    })
  })

  test('no fee at all is a valid arrangement', () => {
    expect(quote(1000, terms({ fixed: 0, basisPoints: 0 }))).toMatchObject({
      fee: 0,
      net: 1000,
    })
  })
})

describe('refusing a withdrawal', () => {
  test('nothing to withdraw', () => {
    expect(quote(0, terms()).refusal).toBeTruthy()
  })

  test('a negative balance cannot be withdrawn', () => {
    // After a refund on an already-withdrawn sale. Not an error — a state the
    // ledger is designed to hold — but not a thing to send to a bank.
    expect(quote(-500, terms()).refusal).toBeTruthy()
  })

  test('smaller than its own fee', () => {
    const answer = quote(20, terms())
    expect(answer.net).toBeLessThanOrEqual(0)
    expect(answer.refusal).toBe('That is smaller than the fee to send it.')
  })

  test('exactly the fee is still refused', () => {
    // Net zero is a transfer of nothing that costs somebody something.
    expect(quote(25, terms({ basisPoints: 0 })).refusal).toBeTruthy()
  })

  test('a penny above the fee is allowed', () => {
    const answer = quote(26, terms({ basisPoints: 0 }))
    expect(answer).toMatchObject({ fee: 25, net: 1 })
    expect(answer.refusal).toBeUndefined()
  })

  test('below the provider minimum, however healthy the fee looks', () => {
    const answer = quote(400, terms({ minimum: 500 }))
    expect(answer.net).toBeGreaterThan(0)
    expect(answer.refusal).toContain('500')
  })

  test('exactly the minimum is allowed', () => {
    expect(quote(500, terms({ minimum: 500 })).refusal).toBeUndefined()
  })
})
