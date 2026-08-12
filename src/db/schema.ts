import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

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
