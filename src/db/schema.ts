import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

import type { FormFieldDef } from '#/lib/form-shape'

export type { FieldFill, FormChoice, FormFieldDef } from '#/lib/form-shape'
export { choicesOf } from '#/lib/form-shape'

/**
 * Which features this node runs.
 *
 * The node owns this outright — master does not grant, gate or even know about
 * it. A toggle here takes effect on the next request, with no redeploy and no
 * round trip to the control plane, which is the whole point of the node
 * deciding for itself.
 *
 * Rows are keyed by `key` against `FEATURE_CATALOG`; a catalog entry with no row
 * yet reads as disabled, which is how a newly shipped feature behaves on an
 * existing node.
 */
export const features = sqliteTable('features', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  key: text().notNull().unique(),
  enabled: integer({ mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * Node-wide settings. One row.
 *
 * The custom domain lives here rather than on the features that use it, because
 * a node's address is a property of the node — the API keeps its domain even if
 * the frontend feature is switched off.
 *
 * `*Verified` records whether DNS was seen pointing at the right target, so the
 * UI can tell "not set up" from "set up and waiting for propagation" without
 * re-querying on every render.
 */
export const settings = sqliteTable('settings', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /**
   * One registrable domain for the whole node.
   *
   * Every hostname the node needs is derived from it — the site on the apex,
   * the API on `api.`, and email later — so the operator sets this once rather
   * than keeping several fields in step. See `domain-plan.ts`.
   */
  customDomain: text('custom_domain'),
  /** the DNS zone the domain sits in, learned from its nameservers */
  dnsZone: text('dns_zone'),
  /** per-use verification, because the records are added and spread separately */
  frontendVerified: integer('frontend_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  apiVerified: integer('api_verified', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * A Cloudflare account the operator granted DNS access to.
 *
 * Optional convenience: when their domain is on Cloudflare, the node can write
 * the DNS records itself instead of the operator copying five of them by hand.
 * At most one row, and the tokens never leave this Worker.
 */
export const cloudflareConnections = sqliteTable('cloudflare_connections', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  /** epoch seconds; null when Cloudflare did not say */
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * The GitHub account this node is connected to, and the site it publishes.
 *
 * At most one row: a node publishes one site. The access token is stored so the
 * node can push config changes and manage Pages later, and is never returned by
 * any API — see `redactConnection`.
 */
export const githubConnections = sqliteTable('github_connections', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  login: text().notNull(),
  accessToken: text('access_token').notNull(),
  repoOwner: text('repo_owner'),
  repoName: text('repo_name'),
  pagesUrl: text('pages_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * A key that acts as one of this node's users.
 *
 * Not a separate kind of principal with its own scopes — a key *is* the user it
 * belongs to. A website is given an account with the `frontend` role and a key
 * to prove it, which means one place decides what anything may do: change the
 * role and every key held by that account changes with it.
 *
 * Only a hash is kept. The secret is shown once, at the moment it is minted,
 * because a key that can be read back out of the panel is a key that leaks with
 * the panel.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    /** the better-auth user this key acts as */
    userId: text('user_id').notNull(),
    name: text().notNull(),
    /** the readable half, so a key can be recognised without revealing it */
    prefix: text().notNull(),
    hash: text().notNull(),
    /**
     * Origins this key works from. A key shipped in a page's JavaScript is
     * readable by anyone who views source, so the useful question is not
     * whether it leaks but what a copy of it is worth somewhere else. Bound to
     * an origin, a stolen key is worth nothing outside the site it came from.
     *
     * Empty means anywhere, which is right for a key on a server and wrong for
     * one in a browser — so the panel says so when minting.
     */
    allowedOrigins: text('allowed_origins', { mode: 'json' })
      .$type<Array<string>>()
      .notNull()
      .default([]),
    /** most requests per minute; 0 leaves it uncapped */
    ratePerMinute: integer('rate_per_minute').notNull().default(0),
    /**
     * What the person who minted it chose to let it do — the second gate.
     *
     * The first gate is the account's own role and policies, and a key can
     * never reach past it. This is the holder narrowing their own reach before
     * handing it to something else: an agent given a key for one job should be
     * able to do that job and discover nothing else.
     *
     * `null` means unrestricted, which is not the same as `[]`. An empty list
     * is a key that may do nothing, and both are things somebody might mean.
     */
    scopePermissions: text('scope_permissions', { mode: 'json' })
      .$type<Array<string> | null>()
      .default(null),
    /** the same shape a role uses: permission -> field -> rule */
    scopeConditions: text('scope_conditions', { mode: 'json' })
      .$type<Record<string, RoleCondition>>()
      .notNull()
      .default({}),
    /** policies applied to this key alone, on top of the account's */
    scopePolicies: text('scope_policies', { mode: 'json' })
      .$type<Array<string>>()
      .notNull()
      .default([]),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('api_keys_prefix').on(table.prefix)],
)

/**
 * An automation: when this happens, tell these people, this way.
 *
 * Three columns for three questions that change independently — `event` and
 * `when` say which records set it off, `audience` says who hears, `channels`
 * says how. Splitting them is what lets one form's enquiries reach the trade
 * desk by email today and by SMS later without touching the rows.
 *
 * `when` reuses the shape role conditions use, because it is the same question
 * asked twice: which records does this apply to. A submission's own answers are
 * addressed as `data.<field>`.
 */
export const automations = sqliteTable('automations', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  /** a key from the trigger catalog, e.g. `submission.created` */
  event: text().notNull(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  /** field -> rule, e.g. { "formId": { "in": [3] } } */
  when: text({ mode: 'json' }).$type<Record<string, AutomationRule>>().notNull().default({}),
  /** people, roles, policies and bare addresses */
  audience: text({ mode: 'json' }).$type<Record<string, Array<string>>>().notNull().default({}),
  /** channel keys; unavailable ones are stored and skipped until they exist */
  channels: text({ mode: 'json' }).$type<Array<string>>().notNull().default(['email']),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/** How an automation narrows the records it fires on. */
export type AutomationRule = {
  in?: Array<string | number>
  eq?: string | number
  contains?: string
  filled?: boolean
}

/**
 * One attempt to tell one person, on one channel.
 *
 * Written whether or not it worked, because "did they get told" is the question
 * anyone asks after the fact and the alternative is guessing from mail logs.
 * It is also where the in-app channel comes from when it lands: an unread
 * notification is a row here, so that channel is a read rather than new
 * plumbing.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    automationId: integer('automation_id'),
    /** which record set it off, so the panel can link back to it */
    subjectType: text('subject_type').notNull().default('submission'),
    subjectId: integer('subject_id'),
    channel: text().notNull(),
    /** the address, phone or user id it was aimed at */
    target: text().notNull(),
    /** set when the target is someone with an account here */
    userId: text('user_id'),
    /** queued -> sent | failed | skipped */
    status: text().notNull().default('queued'),
    detail: text(),
    readAt: integer('read_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('notifications_user_read').on(table.userId, table.readAt)],
)

/**
 * A business selling on this node.
 *
 * On a single-vendor node there is one row and almost nobody thinks about it.
 * On a marketplace there are many, and every sellable thing carries a
 * `vendorId` — which is the entire difference between features 1 and 2, and
 * between 3 and 4. There is no second permission system for marketplaces:
 * "a vendor sees their own listings" is a policy condition, evaluated by the
 * same engine that already keeps a member to their own profile.
 *
 * Introduced before anything sellable exists, on purpose. Adding this column to
 * a table with history in it means deciding what the old rows meant, and there
 * is nothing to decide while those tables do not exist yet.
 */
export const vendors = sqliteTable('vendors', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** what a storefront URL says, and what a rule names */
  slug: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  /** where this vendor is written to about their own sales */
  email: text(),
  /** `active` sells; `suspended` keeps its rows and stops taking money */
  status: text().notNull().default('active'),
  /**
   * The connected account at the payment provider.
   *
   * Not a bank account. Vendors give their bank details to Stripe on its own
   * hosted onboarding, and what comes back here is an id — so this node never
   * holds an account number, and Stripe carries the identity checks.
   */
  stripeAccountId: text('stripe_account_id'),
  /** what the provider says: `none`, `pending`, `restricted`, `ready` */
  onboardingStatus: text('onboarding_status').notNull().default('none'),
  /** the provider's own answer to "may this account be paid" */
  payoutsEnabled: integer('payouts_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * Who acts for a vendor.
 *
 * A join table rather than a column on the account, for two reasons. Better
 * Auth owns the user table and migrates it itself, so Drizzle should not be
 * adding columns to it. And a person can work for two businesses — rare on day
 * one, and impossible to add later without a migration that has to guess.
 */
export const vendorMembers = sqliteTable(
  'vendor_members',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    vendorId: integer('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    /** a better-auth user id */
    userId: text('user_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    // Belonging twice is not a stronger belonging, and would double every row
    // a join produces.
    uniqueIndex('vendor_members_unique').on(table.vendorId, table.userId),
    index('vendor_members_user').on(table.userId),
  ],
)

/**
 * Something for sale.
 *
 * Price is an integer in the smallest unit, like everything else that is money,
 * and it is copied onto the order line at the moment of sale — so changing it
 * here changes what the next buyer pays and nothing about what the last one did.
 *
 * `vendorId` is null on a single-vendor node and set on a marketplace. Nothing
 * in this table behaves differently either way; what changes is which policy
 * lets somebody edit the row.
 */
export const products = sqliteTable(
  'products',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    /** what a storefront URL says */
    slug: text().notNull().unique(),
    name: text().notNull(),
    blurb: text(),
    /** smallest unit of `currency` on the payment provider */
    price: integer().notNull().default(0),
    /** `draft` is invisible; `published` sells; `retired` keeps its orders */
    status: text().notNull().default('draft'),
    vendorId: integer('vendor_id'),
    /**
     * How many times one purchase may be downloaded, and for how long.
     *
     * Not DRM. A determined buyer downloads once and does what they like, and
     * pretending otherwise would mean building something that annoys honest
     * people. This is a bound on a link being passed around, which is a
     * different and much smaller problem.
     */
    downloadLimit: integer('download_limit').notNull().default(5),
    downloadDays: integer('download_days').notNull().default(30),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('products_vendor').on(table.vendorId)],
)

/**
 * The file somebody is actually buying.
 *
 * Stored in the node's own R2 bucket, which every node has had since it was
 * provisioned and nothing has used until now. The key is opaque and includes a
 * random part: a bucket is not a public directory, but a guessable key in one
 * is a worse thing to rely on than a key that cannot be guessed.
 */
export const productAssets = sqliteTable(
  'product_assets',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** what the buyer's file is called when it lands */
    filename: text().notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    /** the R2 object key; never shown to anybody */
    objectKey: text('object_key').notNull(),
    size: integer().notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('product_assets_product').on(table.productId)],
)

/**
 * Somebody's right to download something they paid for.
 *
 * The link in the email is not the thing being checked. The link says *which*
 * entitlement, and this row says whether it may still be used — so a link
 * forwarded to a friend stops working when the count runs out rather than
 * never, and a refund can take it away without chasing the email.
 */
export const entitlements = sqliteTable(
  'entitlements',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    orderId: integer('order_id').notNull(),
    orderItemId: integer('order_item_id').notNull(),
    productId: integer('product_id').notNull(),
    /** null for a guest purchase; the email is then the only way back */
    buyerUserId: text('buyer_user_id'),
    buyerEmail: text('buyer_email'),
    downloadsUsed: integer('downloads_used').notNull().default(0),
    downloadLimit: integer('download_limit').notNull().default(5),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    /** set by a refund; the file is already read, and this is still worth doing */
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    // One per line, so a webhook delivered twice cannot mint a second right.
    uniqueIndex('entitlements_order_item').on(table.orderItemId),
    index('entitlements_buyer').on(table.buyerUserId),
  ],
)

/**
 * How this node takes money.
 *
 * One row. The provider is chosen by rootAdmin, who pastes their own keys and
 * is handed a webhook URL to paste into the provider's console — the same shape
 * the GitHub and Cloudflare connections already use, because it is the shape
 * that keeps the node out of the middle of somebody else's account.
 *
 * The secret and the webhook secret are sealed with a key that lives in the
 * Worker's environment. See `secrets.ts` for what that does and does not buy.
 */
export const paymentProviders = sqliteTable('payment_providers', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** `stripe`, today */
  key: text().notNull().unique(),
  /** safe to show: it is in every checkout page already */
  publishableKey: text('publishable_key'),
  /** sealed */
  secretKey: text('secret_key'),
  /** sealed; proves a webhook came from the provider */
  webhookSecret: text('webhook_secret'),
  /** ISO 4217, upper case */
  currency: text().notNull().default('USD'),
  enabled: integer({ mode: 'boolean' }).notNull().default(false),
  /**
   * What a withdrawal costs, quoted to the vendor before they take it.
   *
   * Entered by rootAdmin to match their own provider pricing, because there is
   * no endpoint that answers "what will this payout cost" — it depends on
   * country, account type and whatever agreement they have. The real figure is
   * written back afterwards from the payout's balance transaction; this is what
   * is shown at the button.
   */
  payoutFeeFixed: integer('payout_fee_fixed').notNull().default(0),
  /** basis points, so 25 is 0.25% */
  payoutFeeBasisPoints: integer('payout_fee_basis_points').notNull().default(0),
  /** below this, a withdrawal is refused rather than eaten by its own fee */
  payoutMinimum: integer('payout_minimum').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * Everything that has ever moved a vendor's balance.
 *
 * Append-only, and the balance is its sum. The same reasoning as the event log,
 * for a stronger reason: a running total can explain itself, and it can hold
 * the one case a subtracted column cannot — **a vendor owing the platform
 * money**, after a refund lands on a sale they have already withdrawn. There is
 * no clawback from somebody's bank account, so that has to be a number the
 * system carries rather than an error it raises.
 *
 * Positive is owed to the vendor, negative is taken away. A withdrawal posts
 * two lines, the net and the fee, which together are the gross — so the fee is
 * visible in the history rather than implied by a gap.
 */
export const vendorLedger = sqliteTable(
  'vendor_ledger',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    vendorId: integer('vendor_id').notNull(),
    /** `sale` | `refund` | `withdrawal` | `fee` | `adjustment` */
    kind: text().notNull(),
    /** smallest unit; signed */
    amount: integer().notNull(),
    currency: text().notNull(),
    orderItemId: integer('order_item_id'),
    payoutId: integer('payout_id'),
    note: text(),
    /**
     * What makes a line unrepeatable.
     *
     * `sale:12`, `refund:12`, `withdrawal:3`. A retried webhook posts the same
     * key and the unique index refuses it — the same discipline the payment
     * events table uses, because the failure is the same one: paying somebody
     * twice for one sale.
     */
    dedupeKey: text('dedupe_key'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    uniqueIndex('vendor_ledger_dedupe').on(table.dedupeKey),
    index('vendor_ledger_vendor').on(table.vendorId),
  ],
)

/**
 * One withdrawal a vendor asked for.
 *
 * `feeEstimate` is what they were shown and agreed to; `feeActual` is what the
 * provider charged, written back when it is known. Keeping both is the
 * difference between a transparent fee and a number somebody made up — and the
 * gap between them, over time, is how a wrong formula is noticed.
 */
export const payouts = sqliteTable(
  'payouts',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    vendorId: integer('vendor_id').notNull(),
    currency: text().notNull(),
    /** what left the balance, in the smallest unit */
    gross: integer().notNull(),
    feeEstimate: integer('fee_estimate').notNull().default(0),
    feeActual: integer('fee_actual'),
    /** what the vendor receives */
    net: integer().notNull(),
    /** platform balance -> connected account */
    transferId: text('transfer_id'),
    /** connected account -> their bank */
    providerPayoutId: text('provider_payout_id'),
    /** `pending` | `paid` | `failed` */
    status: text().notNull().default('pending'),
    failureReason: text('failure_reason'),
    /** one per request, so a double-click cannot pay twice */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    uniqueIndex('payouts_idempotency').on(table.idempotencyKey),
    index('payouts_vendor').on(table.vendorId),
  ],
)

/**
 * One purchase.
 *
 * `reference` rather than the id is what a buyer sees and what a return page
 * looks up, so the sequence of this node's sales is not on the internet.
 *
 * Every amount is an integer in the currency's smallest unit — cents, pence,
 * fils. Not a float, ever: a price is a count of the smallest thing that
 * exists, and the moment it becomes 19.99 somebody eventually gets 19.989999.
 */
export const orders = sqliteTable(
  'orders',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    /** public, unguessable, what the buyer is shown */
    reference: text().notNull().unique(),
    /** null for a guest checkout */
    buyerUserId: text('buyer_user_id'),
    buyerEmail: text('buyer_email'),
    currency: text().notNull(),
    /** smallest unit */
    total: integer().notNull().default(0),
    /**
     * `pending` until the provider says otherwise, and it is the provider that
     * says so — never the browser coming back from checkout.
     */
    status: text().notNull().default('pending'),
    providerKey: text('provider_key').notNull(),
    /** the checkout session, so a webhook can find its way home */
    providerRef: text('provider_ref'),
    paymentIntentId: text('payment_intent_id'),
    /**
     * Written at checkout even on a single-vendor node, where it looks
     * pointless. It is what a later transfer is grouped by, and a charge
     * created without one cannot be paid out against afterwards.
     */
    transferGroup: text('transfer_group'),
    paidAt: integer('paid_at', { mode: 'timestamp' }),
    refundedTotal: integer('refunded_total').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    index('orders_provider_ref').on(table.providerRef),
    index('orders_buyer').on(table.buyerUserId),
  ],
)

/**
 * What was bought, at the price it was bought at.
 *
 * The price is copied here rather than read from the product later. A product
 * whose price changes must not rewrite what somebody already paid, and a
 * refund six months on has to agree with the receipt.
 *
 * `vendorId` and `vendorShare` are here from the first single-vendor sale,
 * when both look like ceremony. They are what every ledger line is posted from
 * once vendors withdraw, and they cannot be reconstructed afterwards.
 */
export const orderItems = sqliteTable(
  'order_items',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** what this line is: `product`, `booking`, … filled in by later features */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    /** what the buyer saw it called, kept even if the thing is renamed */
    name: text().notNull(),
    quantity: integer().notNull().default(1),
    /** smallest unit, per one */
    unitAmount: integer('unit_amount').notNull().default(0),
    /** smallest unit, the line total */
    amount: integer().notNull().default(0),
    vendorId: integer('vendor_id'),
    /** what the vendor is owed for this line, before any withdrawal fee */
    vendorShare: integer('vendor_share').notNull().default(0),
    /** what the platform keeps */
    platformFee: integer('platform_fee').notNull().default(0),
  },
  (table) => [index('order_items_order').on(table.orderId)],
)

/**
 * Every webhook the provider has sent, kept whether or not it changed anything.
 *
 * This table *is* the idempotency guarantee, and it is a unique index rather
 * than a check-then-write. Providers retry, and they deliver out of order: the
 * same `payment_intent.succeeded` can arrive three times because the first two
 * responses were slow. Reading "have I seen this" and then acting leaves a gap
 * between the two where a second delivery fits, and the symptom is a customer
 * charged once and fulfilled twice.
 *
 * So the insert comes first. If it conflicts, the event has been seen and there
 * is nothing to do — the database decided, not the code.
 */
export const paymentEvents = sqliteTable(
  'payment_events',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    providerKey: text('provider_key').notNull(),
    /** the provider's own id for this delivery */
    providerEventId: text('provider_event_id').notNull(),
    type: text().notNull(),
    payload: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    /** null while it is being applied; set when it has been */
    appliedAt: integer('applied_at', { mode: 'timestamp' }),
    result: text(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    uniqueIndex('payment_events_unique').on(
      table.providerKey,
      table.providerEventId,
    ),
  ],
)

/**
 * Something that happened, kept because it cannot be worked out later.
 *
 * The reason this exists before anything reads it: recording cannot be
 * backfilled. A node live for a month before somebody writes this table has
 * lost a month, and no dashboard built afterwards can get it back. So it is
 * written from the day the node runs and read whenever the reading is built.
 *
 * Decisions, not traffic. A row here is somebody doing something — an enquiry
 * arriving, a form being published, an order paid, a slot booked — and never a
 * request being served. The distinction is what keeps a busy node from filling
 * its database with its own logs.
 *
 * `vendorId` is null until vendors exist. It is present now because adding a
 * column to a table with history in it means deciding what the old rows meant,
 * and there is nothing to decide while the table is empty.
 */
export const events = sqliteTable(
  'events',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    /** a key from the event catalog, e.g. `submission.created` */
    name: text().notNull(),
    /** who did it; null for anything the node did on its own */
    actorUserId: text('actor_user_id'),
    /** whether that actor was a key rather than a person at a browser */
    viaKey: integer('via_key', { mode: 'boolean' }).notNull().default(false),
    /** whose business it concerns, once there is more than one */
    vendorId: integer('vendor_id'),
    /** what it happened to: a resource name and its id */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    /** anything worth keeping that is not a column */
    detail: text({ mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    // The two questions a dashboard asks: what happened lately, and what
    // happened to this vendor lately.
    index('events_created').on(table.createdAt),
    index('events_vendor_created').on(table.vendorId, table.createdAt),
  ],
)

/**
 * A role, as the business defines it.
 *
 * Deliberately a row rather than a type in code. Whoever runs the business
 * decides what its team looks like — a two-person shop with an owner and a
 * bookkeeper, an agency with designers who may touch the site but not the
 * submissions, a shift roster where each person only sees their own branch's
 * enquiries. None of those shapes can be known here, so the catalog in code
 * says what *can* be granted and rows like this say what *is*.
 *
 * `permissions` is the RBAC half: which keys from the catalog this role holds.
 * `conditions` is the PBAC half: for a permission the role holds, an optional
 * rule narrowing which records it reaches — `submissions:read` over every form
 * is a different job from `submissions:read` over one.
 */
export const roles = sqliteTable('roles', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** stable id, stored on the user; renaming a role must not orphan anyone */
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  permissions: text({ mode: 'json' }).$type<Array<string>>().notNull().default([]),
  /** permission key -> field -> rule, e.g. { "submissions:read": { "formId": { "in": [3] } } } */
  conditions: text({ mode: 'json' })
    .$type<Record<string, RoleCondition>>()
    .notNull()
    .default({}),
  /**
   * Policies this role carries, by key.
   *
   * A role's own `permissions` and `conditions` above are still its own — they
   * are the quick way to say something once, for a role nobody else shares.
   * Policies are for the rest: the same narrowing wanted by four roles, written
   * once and attached four times.
   */
  policies: text({ mode: 'json' }).$type<Array<string>>().notNull().default([]),
  /** seeded and not deletable — the node must always have a way back in */
  builtin: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * How a permission is narrowed. Each entry is a field and what it must match.
 *
 * `in` and `eq` are written down when the rule is written. `self` and `mine`
 * are resolved against whoever is asking, which is what lets one rule serve
 * everybody who holds the role — one policy saying "their own vendor's orders"
 * works for forty vendors without being written forty times.
 */
export type RoleCondition = Record<
  string,
  {
    in?: Array<string | number>
    eq?: string | number
    /** the asking account's own id */
    self?: boolean
    /** any vendor the asking account acts for */
    mine?: boolean
  }
>

/**
 * A named rule about records, attachable to any number of roles.
 *
 * Roles answer "what kind of access is this". Conditions answer "over which
 * records". Until now the second lived inside the first, which meant a business
 * with four desks and one rule about whose enquiries each may read had to write
 * that rule four times and remember all four when it changed.
 *
 * A policy lifts it out: policies → roles → users. The role stays the thing a
 * person is given, and the policy becomes the thing a rule is. It is the shape
 * IAM settled on for the same reason, including the part that matters most —
 * `deny` beats `allow`, always. A rule that says "not the HR enquiries" has to
 * survive somebody later attaching a generous role, or it is not a rule.
 */
export const policies = sqliteTable('policies', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** stable id, referenced by roles; renaming must not detach anything */
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  /** `allow` widens what a role reaches; `deny` narrows it and wins ties */
  effect: text().notNull().default('allow'),
  /** the permissions this policy speaks about; `*` means all of them */
  permissions: text({ mode: 'json' }).$type<Array<string>>().notNull().default([]),
  /**
   * Which records it speaks about. Empty means all of them — an allow with no
   * condition is a plain grant, and a deny with no condition is a flat refusal.
   */
  condition: text({ mode: 'json' })
    .$type<RoleCondition>()
    .notNull()
    .default({}),
  builtin: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * An invitation to join this node's team.
 *
 * A link rather than an email, because a node has no mail sender of its own
 * yet. The token is the credential: it is long, single-use, and expires, so a
 * link that leaks is bounded rather than permanent.
 */
export const invitations = sqliteTable('invitations', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  email: text().notNull(),
  roleKey: text('role_key').notNull(),
  token: text().notNull().unique(),
  invitedBy: text('invited_by'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * The push webhook this node registered on the site's repository.
 *
 * Its own table rather than a column on `github_connections`, because node
 * migrations only ever create tables — an ALTER would fail the second time a
 * node is provisioned, which happens on every deploy.
 *
 * The secret is ours: we generate it, hand it to GitHub once, and check every
 * delivery against it. It never leaves this row.
 */
export const repoHooks = sqliteTable('repo_hooks', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** GitHub's id for the hook, so it is updated rather than duplicated */
  hookId: integer('hook_id').notNull(),
  url: text().notNull(),
  secret: text().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * One field in a form's definition. Stored as JSON on the form row.
 *
 * This is deliberately the same shape the site's `admin-cms.json` declares, so
 * a field can move between the two without being translated. The node ignores
 * `width` and `showWhen` — they say how the site draws the field, not what it
 * accepts — but it stores them, because the alternative is dropping them every
 * time a form is saved from the panel.
 */
/**
 * A form the node's operator builds in the admin panel. `slug` is what the
 * public API addresses it by, and what a static frontend hard-codes.
 *
 * The field list lives in a JSON column rather than its own table: a form's
 * fields are only ever read and written as a whole, and keeping them together
 * means editing a form is one row write.
 */
export const forms = sqliteTable('forms', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  slug: text().notNull().unique(),
  /** draft forms are invisible to the public API; paused ones answer 410 */
  status: text().notNull().default('draft'),
  fields: text({ mode: 'json' })
    .$type<Array<FormFieldDef>>()
    .notNull()
    .default([]),
  successMessage: text('success_message'),
  /**
   * What the form collects.
   *
   * `public` is the ordinary kind: anyone may send it and every send is a new
   * row. `profile` binds it to whoever is signed in — one row per person,
   * edited rather than resent, and readable back to them. It is the same form
   * builder either way; only what a submission *is* changes.
   */
  target: text().notNull().default('public'),
  /** a profile form the site asks for before letting someone get on with it */
  requiredAtSignup: integer('required_at_signup', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * One submission against a form. `data` holds the submitted values keyed by
 * field name — deliberately schemaless, because a form's shape can change after
 * submissions already exist and old rows must stay readable.
 */
export const formSubmissions = sqliteTable(
  'form_submissions',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    formId: integer('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /**
     * Whose it is, when it belongs to somebody.
     *
     * Null for the anonymous kind, which is most of them. Set for a profile,
     * and that is what makes `self` scoping work: a role narrowed to
     * `{ userId: { self: true } }` reaches its own row and no one else's, in
     * the same WHERE clause every other narrowing uses.
     */
    userId: text('user_id'),
    data: text({ mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text().notNull().default('new'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('submissions_form_created').on(table.formId, table.createdAt)],
)
