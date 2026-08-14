import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { forms } from '#/db/schema'
import type { FormFieldDef } from '#/lib/form-shape'
import type { Principal } from './authz'
import { allows, can } from './authz'

/**
 * The database, as files the CMS already knows how to edit.
 *
 * The awkward part of putting dynamic data in a git-backed CMS is that the CMS
 * only believes in files. The tempting answer is to write the rows into the
 * repository and let it read them there — but this repository is public, it is
 * how the site is published, and a node's forms are not the sort of thing to
 * publish as a side effect of making them editable.
 *
 * So the files are not written anywhere. They are answered.
 *
 * Sveltia asks for a listing (a git tree), and gets one with these entries
 * added. It then asks for their contents by blob id, and gets those too. Every
 * id here is `sha256("virtual:" + path)` — derived rather than stored, so the
 * same row always has the same id, no table is needed to remember which is
 * which, and an id from a stale tab still resolves to the row it named.
 *
 * Nothing leaves the node. A commit that touches one of these paths never
 * reaches GitHub; it becomes a database write, and the CMS is told the commit
 * happened. Which is the whole trick: to Sveltia this is one repository with a
 * few more files in it, and everything it does — the widgets, the validation,
 * the diffing, the editing UI — works on them unchanged.
 */

/** Where the answered files live. Deliberately dotted, so it cannot collide. */
export const VIRTUAL_ROOT = '.node'

export interface VirtualEntry {
  path: string
  /** the row, as the document the CMS edits */
  text: string
  /** derived from the path, so it is stable without being stored */
  oid: string
  updatedAt: Date | null
}

async function oidFor(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`virtual:${path}`),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    // A git object id is forty hex characters, and Sveltia passes it straight
    // through to a query that expects one.
    .slice(0, 40)
}

/** What a form looks like as a document. */
function formDocument(row: {
  name: string
  slug: string
  status: string
  target: string
  requiredAtSignup: boolean
  successMessage: string | null
  fields: Array<FormFieldDef> | null
}) {
  return {
    name: row.name,
    slug: row.slug,
    status: row.status,
    target: row.target,
    required_at_signup: row.requiredAtSignup,
    success_message: row.successMessage ?? '',
    fields: row.fields ?? [],
  }
}

/**
 * Every answered file this account may see.
 *
 * Filtered here rather than after the fact, because a listing is how the CMS
 * decides what exists: a row left out of this does not appear, cannot be
 * opened, and has no id anybody could ask for.
 */
export async function virtualEntries(
  db: NodeDb,
  principal: Principal,
  enabledFeatures: Array<string>,
): Promise<Array<VirtualEntry>> {
  if (!enabledFeatures.includes('forms')) return []
  if (!can(principal, 'forms:read')) return []

  const rows = await db.select().from(forms)
  const entries: Array<VirtualEntry> = []

  for (const row of rows) {
    // The same narrowing the panel applies to the same rows. A desk scoped to
    // two forms sees two forms here, in a CMS that has never heard of a form.
    if (!allows(principal, 'forms:read', { id: row.id, formId: row.id })) {
      continue
    }
    const path = `${VIRTUAL_ROOT}/forms/${row.slug}.json`
    entries.push({
      path,
      text: JSON.stringify(formDocument(row), null, 2),
      oid: await oidFor(path),
      updatedAt: row.createdAt ?? null,
    })
  }

  return entries
}

export function isVirtual(path: string): boolean {
  return path === VIRTUAL_ROOT || path.startsWith(`${VIRTUAL_ROOT}/`)
}

/**
 * Applies a write to the database instead of the repository.
 *
 * Returns a message when it may not happen, so the caller can refuse the whole
 * commit — a mutation that half-applied would leave the CMS showing one thing
 * and the node serving another.
 */
export async function applyVirtualWrite(
  db: NodeDb,
  principal: Principal,
  path: string,
  document: unknown,
): Promise<string | null> {
  const match = new RegExp(`^${VIRTUAL_ROOT}/forms/(.+)\\.json$`).exec(path)
  if (!match) return `There is nothing at ${path} to change.`

  const slug = match[1]!
  const [row] = await db.select().from(forms).where(eq(forms.slug, slug)).limit(1)
  if (!row) return `There is no form called ${slug}.`

  if (!can(principal, 'forms:write')) {
    return 'Your account cannot change forms.'
  }
  if (!allows(principal, 'forms:write', { id: row.id, formId: row.id })) {
    return `Your account cannot change ${slug}.`
  }

  const body = (document ?? {}) as Record<string, unknown>
  await db
    .update(forms)
    .set({
      name: String(body.name ?? row.name),
      status: String(body.status ?? row.status),
      target: String(body.target ?? row.target),
      requiredAtSignup: Boolean(body.required_at_signup ?? row.requiredAtSignup),
      successMessage:
        body.success_message === undefined
          ? row.successMessage
          : String(body.success_message),
      fields: Array.isArray(body.fields)
        ? (body.fields as Array<FormFieldDef>)
        : row.fields,
    })
    .where(eq(forms.id, row.id))

  return null
}

export async function applyVirtualDelete(
  db: NodeDb,
  principal: Principal,
  path: string,
): Promise<string | null> {
  const match = new RegExp(`^${VIRTUAL_ROOT}/forms/(.+)\\.json$`).exec(path)
  if (!match) return `There is nothing at ${path} to delete.`

  const slug = match[1]!
  const [row] = await db.select().from(forms).where(eq(forms.slug, slug)).limit(1)
  if (!row) return null

  if (!can(principal, 'forms:delete')) {
    return 'Your account cannot delete forms.'
  }
  if (!allows(principal, 'forms:delete', { id: row.id, formId: row.id })) {
    return `Your account cannot delete ${slug}.`
  }

  await db.delete(forms).where(eq(forms.id, row.id))
  return null
}

/**
 * The collections these files belong to, in Sveltia's own vocabulary.
 *
 * Appended to the repo's own configuration, so the dashboard has one sidebar
 * with the site's collections and the node's in it — and the node's are
 * ordinary `folder` collections pointed at a folder that does not exist on
 * disk. Nothing in Sveltia is aware of the difference.
 */
export function virtualCollections(principal: Principal): Array<unknown> {
  if (!can(principal, 'forms:read')) return []

  return [
    {
      name: 'node_forms',
      label: 'Forms',
      label_singular: 'Form',
      icon: 'assignment',
      folder: `${VIRTUAL_ROOT}/forms`,
      extension: 'json',
      format: 'json',
      // Creating one would have to invent a slug before the node has a row for
      // it; adding forms is the panel's job, and editing them is this one's.
      create: false,
      delete: can(principal, 'forms:delete'),
      identifier_field: 'slug',
      summary: '{{fields.name}} — {{fields.status}}',
      description:
        'The forms this node serves. Saved here, they take effect immediately — these are not files in the repository.',
      fields: [
        { name: 'name', label: 'Name', widget: 'string' },
        { name: 'slug', label: 'Slug', widget: 'string', required: true },
        {
          name: 'status',
          label: 'Status',
          widget: 'select',
          options: ['draft', 'published', 'paused'],
        },
        {
          name: 'target',
          label: 'What it collects',
          widget: 'select',
          options: [
            { label: 'Anyone — a new row each time', value: 'public' },
            { label: 'The account — one row per person', value: 'profile' },
          ],
        },
        {
          name: 'required_at_signup',
          label: 'Required before anything else',
          widget: 'boolean',
          required: false,
        },
        {
          name: 'success_message',
          label: 'Message after sending',
          widget: 'string',
          required: false,
        },
        {
          name: 'fields',
          label: 'Fields',
          widget: 'list',
          fields: [
            { name: 'name', label: 'Key', widget: 'string' },
            { name: 'label', label: 'Label', widget: 'string' },
            {
              name: 'type',
              label: 'Type',
              widget: 'select',
              options: [
                'text',
                'email',
                'tel',
                'url',
                'textarea',
                'number',
                'select',
                'checkbox',
                'date',
              ],
            },
            {
              name: 'required',
              label: 'Required',
              widget: 'boolean',
              required: false,
            },
            {
              name: 'placeholder',
              label: 'Placeholder',
              widget: 'string',
              required: false,
            },
          ],
        },
      ],
    },
  ]
}
