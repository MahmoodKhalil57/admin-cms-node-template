import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

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
 * One field in a form's definition. Stored as JSON on the form row.
 *
 * This is deliberately the same shape the site's `admin-cms.json` declares, so
 * a field can move between the two without being translated. The node ignores
 * `width` and `showWhen` — they say how the site draws the field, not what it
 * accepts — but it stores them, because the alternative is dropping them every
 * time a form is saved from the panel.
 */
export interface FormFieldDef {
  name: string
  label: string
  type:
    | 'text'
    | 'email'
    | 'tel'
    | 'url'
    | 'textarea'
    | 'number'
    | 'select'
    | 'checkbox'
    | 'date'
  required?: boolean
  placeholder?: string
  /** for `select`; older rows may hold plain strings */
  options?: Array<FormChoice | string>
  /** how wide the field sits on the site's form */
  width?: 'full' | 'half'
  /** the site shows this field only when a sibling matches */
  showWhen?: {
    field: string
    is: 'equal' | 'not_equal' | 'filled' | 'empty'
    value?: string
  }
}

/** A choice on a select field: the value stored, the label shown. */
export interface FormChoice {
  value: string
  label: string
}

/** Choices in one shape, whichever way the row was written. */
export function choicesOf(field: FormFieldDef): Array<FormChoice> {
  return (field.options ?? []).map((choice) =>
    typeof choice === 'string'
      ? { value: choice, label: choice }
      : { value: String(choice.value), label: String(choice.label ?? choice.value) },
  )
}

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
