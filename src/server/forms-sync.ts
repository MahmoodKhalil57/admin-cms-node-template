import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { forms as formsTable } from '#/db/schema'
import type { FormFieldDef } from '#/db/schema'
import type { RepoRef } from './static-store'
import { StaticError } from './static-store'
import { commitFiles, readRepoFile } from './builder-store'

/**
 * Keeping `admin-cms.json` and the node's forms table in step.
 *
 * They describe the same forms from two sides: the file is what the site
 * declares it expects, the table is what the node serves and what submissions
 * point at. Editing either used to leave the other stale.
 *
 * The file is shaped to match the table on purpose — `slug`, `name`, `status`,
 * `successMessage` and `fields` are the node's own columns, so a form moves
 * between the two without being translated and nothing is lost in the crossing.
 * What the node has no opinion about lives under `site`, which this never
 * touches: it is carried through every sync exactly as found.
 */

export const PROJECT_PATH = 'admin-cms.json'

export interface ProjectForm {
  slug?: string
  name?: string
  status?: string
  successMessage?: string | null
  fields?: Array<FormFieldDef>
  /** presentation the node has no column for */
  site?: Record<string, unknown>
  [key: string]: unknown
}

export interface ProjectFile {
  forms?: Array<ProjectForm>
  [key: string]: unknown
}

const STATUSES = ['draft', 'published', 'paused']

function statusOf(value: unknown, fallback: string): string {
  const status = String(value ?? '')
  return STATUSES.includes(status) ? status : fallback
}

function formsOf(file: ProjectFile): Array<ProjectForm> {
  return Array.isArray(file.forms) ? file.forms : []
}

/** Only what the node stores, so a stray key in the file cannot reach a column. */
function columnsOf(form: ProjectForm, fallbackStatus: string) {
  return {
    name: String(form.name ?? form.slug ?? ''),
    status: statusOf(form.status, fallbackStatus),
    fields: (Array.isArray(form.fields) ? form.fields : []).filter(
      (field) => field && field.name,
    ) as Array<FormFieldDef>,
    successMessage:
      typeof form.successMessage === 'string' ? form.successMessage : null,
  }
}

/**
 * The declaration, applied to the node.
 *
 * A form the file names but the node lacks is created; one they share is
 * updated. A form the file no longer names is **paused rather than deleted** —
 * its submissions are real, and dropping them because a config file changed is
 * not a trade to make on someone's behalf. Pausing is reversible and the public
 * API already answers 410 for it.
 */
export async function applyProjectToDb(
  db: NodeDb,
  project: ProjectFile,
): Promise<{ created: number; updated: number; paused: number }> {
  const declared = formsOf(project).filter((form) => form.slug)
  const existing = await db.select().from(formsTable)
  const bySlug = new Map(existing.map((row) => [row.slug, row]))

  let created = 0
  let updated = 0

  for (const form of declared) {
    const slug = String(form.slug)
    const row = bySlug.get(slug)

    if (!row) {
      // A form the site already declares is one the site expects to work.
      await db.insert(formsTable).values({ slug, ...columnsOf(form, 'published') })
      created += 1
      continue
    }

    const next = columnsOf(form, row.status)
    const unchanged =
      next.name === row.name &&
      next.status === row.status &&
      next.successMessage === row.successMessage &&
      JSON.stringify(next.fields) === JSON.stringify(row.fields)
    if (unchanged) continue

    await db.update(formsTable).set(next).where(eq(formsTable.id, row.id))
    updated += 1
  }

  const names = new Set(declared.map((form) => String(form.slug)))
  const orphans = existing.filter(
    (row) => !names.has(row.slug) && row.status !== 'paused',
  )
  for (const row of orphans) {
    await db
      .update(formsTable)
      .set({ status: 'paused' })
      .where(eq(formsTable.id, row.id))
  }

  return { created, updated, paused: orphans.length }
}

/**
 * The node's forms, written back into the declaration.
 *
 * Declared order is the order the site renders in, so it is kept; forms the
 * node has that the file has not seen are appended. Spreading the existing
 * entry first is what preserves `site` — and anything else a future version of
 * the file grows that this code has never heard of.
 */
export function mergeDbIntoProject(
  project: ProjectFile,
  rows: Array<typeof formsTable.$inferSelect>,
): ProjectFile {
  const current = formsOf(project)
  const declared = new Set(current.map((form) => String(form.slug)))

  const ordered = [
    ...current
      .map((form) => rows.find((row) => row.slug === String(form.slug)))
      .filter(Boolean),
    ...rows.filter((row) => !declared.has(row.slug)),
  ] as Array<typeof formsTable.$inferSelect>

  const forms = ordered.map((row) => {
    const existing =
      current.find((form) => String(form.slug) === row.slug) ?? ({} as ProjectForm)

    const merged: ProjectForm = {
      ...existing,
      slug: row.slug,
      name: row.name,
      status: row.status,
      fields: (row.fields ?? []) as Array<FormFieldDef>,
    }
    if (row.successMessage) merged.successMessage = row.successMessage
    else delete merged.successMessage

    return merged
  })

  return { ...project, forms }
}

async function readProject(ref: RepoRef): Promise<ProjectFile | null> {
  const text = await readRepoFile(ref, PROJECT_PATH)
  if (text === null) return null
  try {
    return JSON.parse(text) as ProjectFile
  } catch {
    throw new StaticError(`${PROJECT_PATH} is not valid JSON.`, 422)
  }
}

/**
 * Write the node's forms back into the declaration and commit.
 *
 * Best-effort by design: the form is already saved when this runs, and a
 * repository that is unreachable — or a node with no site connected yet — must
 * not turn a successful save into a failure. The caller reports what happened
 * rather than throwing it away.
 */
export async function syncDbToRepo(
  ref: RepoRef,
  db: NodeDb,
  message: string,
): Promise<{ committed: boolean; reason?: string }> {
  const project = await readProject(ref)
  if (!project) return { committed: false, reason: `no ${PROJECT_PATH}` }

  const rows = await db.select().from(formsTable)
  const next = mergeDbIntoProject(project, rows)

  if (JSON.stringify(project) === JSON.stringify(next)) {
    return { committed: false, reason: 'no change' }
  }

  await commitFiles(
    ref,
    [{ path: PROJECT_PATH, content: `${JSON.stringify(next, null, 2)}\n` }],
    message,
  )
  return { committed: true }
}
