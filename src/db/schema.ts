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
 * Custom domains live here rather than on the features that use them, because a
 * node's addresses are a property of the node — the API keeps its domain even
 * if the frontend feature is switched off.
 *
 * `*Verified` records whether DNS was seen pointing at the right target, so the
 * UI can tell "not set up" from "set up and waiting for propagation" without
 * re-querying on every render.
 */
export const settings = sqliteTable('settings', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  apiDomain: text('api_domain'),
  apiVerified: integer('api_verified', { mode: 'boolean' }).notNull().default(false),
  frontendDomain: text('frontend_domain'),
  frontendVerified: integer('frontend_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
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

/** One field in a form's definition. Stored as JSON on the form row. */
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
  /** for `select` */
  options?: Array<string>
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
