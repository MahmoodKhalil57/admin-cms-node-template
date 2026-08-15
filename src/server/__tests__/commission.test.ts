import { describe, expect, test } from 'bun:test'

import { MAX_COMMISSION_BPS, splitLine } from '../store/commission'

/**
 * What the platform keeps from a marketplace sale.
 *
 * Tested on its own because it is the number the whole of feature 2 rests on,
 * and because it is applied to every line of every order and then written down
 * permanently. An error here is not a bug somebody notices — it is a number
 * that quietly disagrees with the receipt for as long as the node runs.
 */

describe('splitting a line', () => {
  test('a plain percentage, and the rest is the vendor’s', () => {
    // 15% of 10.00
    expect(splitLine(1000, 1500)).toMatchObject({
      platformFee: 150,
      vendorShare: 850,
    })
  })

  test('the two halves always add back to the line', () => {
    // The property that matters. The ledger credits the vendor their share and
    // the platform keeps the rest, so a pair that does not sum to the line is
    // money that either appeared or vanished.
    for (const amount of [1, 99, 100, 999, 1999, 12_345, 999_999]) {
      for (const bps of [0, 1, 250, 1500, 3333, 9999, 10_000]) {
        const split = splitLine(amount, bps)
        expect(split.platformFee + split.vendorShare).toBe(amount)
      }
    }
  })

  test('the remainder goes to the vendor, not the platform', () => {
    // 10% of 1999 is 199.9. Rounded up the platform takes 200, which is more
    // than the rate it published — small, constant, and in its own favour on
    // every sale. Rounded down it takes 199 and the vendor keeps the penny.
    expect(splitLine(1999, 1000).platformFee).toBe(199)
    expect(splitLine(1999, 1000).vendorShare).toBe(1800)
  })

  test('no commission means the vendor keeps everything', () => {
    expect(splitLine(2500, 0)).toMatchObject({
      platformFee: 0,
      vendorShare: 2500,
    })
  })

  test('a rate cannot exceed the whole line', () => {
    // Not a policy — arithmetic. A vendor share can be zero and must never be
    // negative, because a negative share posts a debit to somebody who just
    // made a sale.
    expect(splitLine(1000, 99_999)).toMatchObject({
      platformFee: 1000,
      vendorShare: 0,
    })
    expect(splitLine(1000, MAX_COMMISSION_BPS).vendorShare).toBe(0)
  })

  test('nonsense rates are refused rather than propagated', () => {
    expect(splitLine(1000, -500).platformFee).toBe(0)
    expect(splitLine(1000, Number.NaN).platformFee).toBe(0)
  })

  test('a tiny sale under a tiny rate costs the vendor nothing', () => {
    // 1% of 1 is 0.01, which is not a penny. Taking one would be a 100%
    // commission on the smallest possible sale.
    expect(splitLine(1, 100)).toMatchObject({ platformFee: 0, vendorShare: 1 })
  })
})
