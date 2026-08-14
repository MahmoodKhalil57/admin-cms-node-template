import { and, eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  entitlements,
  notifications,
  orderItems,
  productAssets,
  products,
} from '#/db/schema'
import type { NodeEnv } from '../env'
import { record } from '../events'
import { sendMail } from '../mailer'

/**
 * Handing over what somebody bought.
 *
 * Runs when the provider says an order is paid, and never when a browser says
 * so. Two steps: mint a right to download, then tell the buyer where. Only the
 * first of those is allowed to matter — an email that does not arrive is a
 * support question, and a right that is not minted is a customer who paid for
 * nothing.
 *
 * So the entitlement is written first, in its own statement, guarded by a
 * unique index on the order line. A webhook delivered twice cannot mint two
 * rights, for the same reason it cannot mark an order paid twice: the database
 * refuses rather than the code remembering.
 */

const LINK_TTL_DAYS_FALLBACK = 30

/* --- links ---------------------------------------------------------------- */

/**
 * A download link.
 *
 * The signature says only *which* entitlement and *until when*. Everything that
 * decides whether a download may happen — the count, the revocation, the
 * expiry — is read from the row at the moment of the click. That separation is
 * the whole design: a link that carried its own permission could not be taken
 * away once sent, and an emailed link is a thing that gets forwarded.
 */
async function key(env: NodeEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`admin-cms:download:${env.BETTER_AUTH_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function signDownload(
  env: NodeEnv,
  entitlementId: number,
  expiresAt: number,
): Promise<string> {
  const body = `${entitlementId}.${expiresAt}`
  const mac = await crypto.subtle.sign(
    'HMAC',
    await key(env),
    new TextEncoder().encode(body),
  )
  return `${body}.${hex(new Uint8Array(mac))}`
}

/** Null for anything forged, malformed or past its date. */
export async function readDownloadToken(
  env: NodeEnv,
  token: string,
): Promise<number | null> {
  const [id, expires, mac] = token.split('.')
  if (!id || !expires || !mac) return null
  if (Number(expires) * 1000 < Date.now()) return null

  const expected = await signDownload(env, Number(id), Number(expires))
  // Whole-string comparison of a value that is already a hash of the inputs;
  // a wrong id or date produces a different mac rather than a shorter one.
  if (expected !== token) return null
  return Number(id)
}

/* --- fulfilment ----------------------------------------------------------- */

export interface Granted {
  entitlementId: number
  productName: string
  filename: string | null
  url: string
}

/**
 * Mints the rights for a paid order and returns what to tell the buyer.
 *
 * Idempotent by construction: the unique index on `orderItemId` means a second
 * run finds the rows already there and reuses them, so a retried webhook sends
 * the same links rather than a second set.
 */
export async function fulfilOrder(
  env: NodeEnv,
  db: NodeDb,
  order: {
    id: number
    reference: string
    buyerUserId: string | null
    buyerEmail: string | null
  },
  origin: string,
): Promise<Array<Granted>> {
  const lines = await db
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, order.id),
        eq(orderItems.subjectType, 'product'),
      ),
    )

  const granted: Array<Granted> = []

  for (const line of lines) {
    const productId = Number(line.subjectId)
    if (!Number.isFinite(productId)) continue

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    if (!product) continue

    const days = product.downloadDays || LINK_TTL_DAYS_FALLBACK
    const expiresAt = new Date(Date.now() + days * 86_400_000)

    let [existing] = await db
      .select()
      .from(entitlements)
      .where(eq(entitlements.orderItemId, line.id))
      .limit(1)

    if (!existing) {
      try {
        const [made] = await db
          .insert(entitlements)
          .values({
            orderId: order.id,
            orderItemId: line.id,
            productId: product.id,
            buyerUserId: order.buyerUserId,
            buyerEmail: order.buyerEmail,
            downloadLimit: product.downloadLimit,
            expiresAt,
          })
          .returning()
        existing = made
      } catch {
        // The unique index refused it, which means another delivery of the same
        // webhook got there first. Read theirs rather than failing.
        ;[existing] = await db
          .select()
          .from(entitlements)
          .where(eq(entitlements.orderItemId, line.id))
          .limit(1)
      }
    }
    if (!existing) continue

    const [asset] = await db
      .select()
      .from(productAssets)
      .where(eq(productAssets.productId, product.id))
      .limit(1)

    const token = await signDownload(
      env,
      existing.id,
      Math.floor(expiresAt.getTime() / 1000),
    )
    granted.push({
      entitlementId: existing.id,
      productName: product.name,
      filename: asset?.filename ?? null,
      url: `${origin}/api/download/${token}`,
    })
  }

  if (granted.length) {
    await record(db, {
      name: 'order.fulfilled',
      subjectType: 'orders',
      subjectId: order.id,
      detail: { reference: order.reference, items: granted.length },
    })
  }

  return granted
}

/**
 * The email, which is allowed to fail.
 *
 * Never able to fail the webhook — every error is caught here and written down
 * as a failed send, because the rights are already minted and the buyer can
 * reach them from their account either way.
 *
 * It *is* awaited, though. A Worker cancels what is still in flight when the
 * response goes out, so firing this and returning meant the send was raced
 * against the reply and usually lost. That is how it was found: the event log
 * showed the order fulfilled and nothing was ever sent.
 */
export async function emailDownloads(
  env: NodeEnv,
  db: NodeDb,
  order: { reference: string; buyerEmail: string | null },
  granted: Array<Granted>,
  hostname?: string | null,
): Promise<void> {
  if (!order.buyerEmail || !granted.length) return

  const lines = granted
    .map((item) => `${item.productName}: ${item.url}`)
    .join('\n')
  const html = granted
    .map(
      (item) =>
        `<p><strong>${item.productName}</strong><br><a href="${item.url}">Download</a></p>`,
    )
    .join('')

  let outcome: { sent: boolean; reason?: string } = {
    sent: false,
    reason: 'not attempted',
  }

  try {
    outcome = await sendMail(
      env,
      {
        to: order.buyerEmail,
        subject: `Your download${granted.length > 1 ? 's' : ''} — ${order.reference}`,
        text: `Thank you. Here is what you bought.\n\n${lines}\n\nThese links expire, and can be opened a limited number of times. If you have an account here, they are also on your account page.`,
        html: `<p>Thank you. Here is what you bought.</p>${html}<p>These links expire, and can be opened a limited number of times. If you have an account here, they are also on your account page.</p>`,
      },
      hostname,
    )
  } catch (error) {
    /* See above. Losing the email is not losing the purchase. */
    outcome = {
      sent: false,
      reason: error instanceof Error ? error.message : 'send failed',
    }
  }

  /*
    Recorded in the same place every other message this node sends is recorded.

    "Did the buyer get their link" is the first question an operator is asked
    about a shop, and an answer that exists only in a log they cannot reach is
    not an answer. Written after the attempt and never able to fail it.
  */
  try {
    await db.insert(notifications).values({
      subjectType: 'order',
      subjectId: null,
      channel: 'email',
      target: order.buyerEmail,
      status: outcome.sent ? 'sent' : 'failed',
      detail: outcome.sent
        ? `Download link for ${order.reference}`
        : (outcome.reason ?? 'send failed'),
    })
  } catch {
    /* ignore */
  }
}

/** Called by a refund. The file is already read; this is still worth doing. */
export async function revokeForOrder(
  db: NodeDb,
  orderId: number,
): Promise<void> {
  await db
    .update(entitlements)
    .set({ revokedAt: new Date() })
    .where(eq(entitlements.orderId, orderId))
}
