import { parse } from 'yaml'

/**
 * Reads a Sveltia CMS config into something the admin can render.
 *
 * The template already carries `static-admin/config.yml` — a complete content
 * model that its own editors use. Rather than inventing a second description of
 * the same content, this reads that file and mirrors it: the same collections,
 * the same fields, the same files on disk. Editing through either surface
 * produces the same commits.
 *
 * Only the parts the template actually uses are mapped. An unrecognised widget
 * degrades to a text input rather than throwing, so an unfamiliar config still
 * loads and stays editable.
 */

export type WidgetKind =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'image'
  | 'list'
  | 'object'
  | 'hidden'
  | 'unknown'

export interface StaticField {
  name: string
  label: string
  widget: WidgetKind
  required: boolean
  hint?: string
  /** for `select` */
  options?: Array<string>
  /** for `list` and `object` */
  fields?: Array<StaticField>
  /**
   * An identifier rather than prose — rendered in mono, because the value
   * becomes a JSON key or a URL segment rather than something a reader sees.
   */
  mono?: boolean
  /**
   * Only relevant when a sibling holds one of these values, e.g. a list of
   * choices applies to a select and to nothing else. Drawn only when it applies.
   */
  condition?: { field: string; value: Array<string> }
}

export interface StaticCollection {
  /** stable id used in URLs, e.g. `pages` */
  name: string
  label: string
  /** a fixed set of files, or every file in a folder */
  kind: 'files' | 'folder'
  /** for `folder` */
  folder?: string
  extension: string
  /** which field supplies the filename when creating, e.g. `slug` */
  slugField?: string
  canCreate: boolean
  canDelete: boolean
  /**
   * Which preview this collection supports. The site frame can only paint what
   * its pages actually render; `forms` asks for the built-in form preview
   * instead, and the default is the site itself.
   */
  preview?: string
  /**
   * For `files`: the fixed entries.
   *
   * Each carries its own fields, because Sveltia lets every file in a `files`
   * collection have a different shape — `site` and `catalog` describe quite
   * different things.
   */
  files?: Array<{
    name: string
    label: string
    file: string
    fields: Array<StaticField>
  }>
  fields: Array<StaticField>
}

const KNOWN_WIDGETS: Array<WidgetKind> = [
  'string',
  'text',
  'number',
  'boolean',
  'select',
  'image',
  'list',
  'object',
  'hidden',
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any

function widgetOf(raw: Raw): WidgetKind {
  const widget = String(raw?.widget ?? 'string')
  // `markdown` and `code` are long-form text as far as this UI is concerned.
  if (widget === 'markdown' || widget === 'code') return 'text'
  return (KNOWN_WIDGETS as Array<string>).includes(widget)
    ? (widget as WidgetKind)
    : 'unknown'
}

function toField(raw: Raw): StaticField {
  const widget = widgetOf(raw)
  const field: StaticField = {
    name: String(raw.name),
    label: String(raw.label ?? raw.name),
    widget,
    // Sveltia treats fields as required unless told otherwise.
    required: raw.required !== false,
    hint: raw.hint ? String(raw.hint) : undefined,
  }

  if (raw.mono === true) field.mono = true

  if (raw.condition?.field) {
    const value = raw.condition.value
    field.condition = {
      field: String(raw.condition.field),
      value: (Array.isArray(value) ? value : [value]).map(String),
    }
  }

  if (widget === 'select' && Array.isArray(raw.options)) {
    field.options = raw.options.map((option: Raw) =>
      typeof option === 'string' ? option : String(option?.value ?? option),
    )
  }

  if ((widget === 'list' || widget === 'object') && Array.isArray(raw.fields)) {
    field.fields = raw.fields.map(toField)
  }

  return field
}

/** The slug template names a field, e.g. `"{{fields.slug}}"`. */
function slugFieldOf(raw: Raw): string | undefined {
  const template = typeof raw?.slug === 'string' ? raw.slug : ''
  return /\{\{fields\.([\w-]+)\}\}/.exec(template)?.[1]
}

export function parseSveltiaConfig(yaml: string): Array<StaticCollection> {
  const config = parse(yaml) as Raw
  const collections: Array<Raw> = Array.isArray(config?.collections)
    ? config.collections
    : []

  return collections.map((raw): StaticCollection => {
    const fields = Array.isArray(raw.fields) ? raw.fields.map(toField) : []

    if (Array.isArray(raw.files)) {
      return {
        name: String(raw.name),
        label: String(raw.label ?? raw.name),
        kind: 'files',
        extension: String(raw.extension ?? 'json'),
        preview: raw.preview ? String(raw.preview) : undefined,
        // A fixed set of files is a fixed set — nothing to add or remove.
        canCreate: false,
        canDelete: false,
        files: raw.files.map((file: Raw) => ({
          name: String(file.name),
          label: String(file.label ?? file.name),
          file: String(file.file),
          fields: Array.isArray(file.fields) ? file.fields.map(toField) : [],
        })),
        // Each file carries its own fields; the collection's own list is the
        // union, used only when a file does not declare any.
        fields,
      }
    }

    return {
      name: String(raw.name),
      label: String(raw.label ?? raw.name),
      kind: 'folder',
      folder: String(raw.folder ?? ''),
      preview: raw.preview ? String(raw.preview) : undefined,
      extension: String(raw.extension ?? 'json'),
      slugField: slugFieldOf(raw),
      canCreate: raw.create === true,
      canDelete: raw.delete !== false,
      fields,
    }
  })
}

/** Per-file fields for a `files` collection, which Sveltia allows to differ. */
export function fieldsForFile(
  yaml: string,
  collection: string,
  file: string,
): Array<StaticField> | undefined {
  const config = parse(yaml) as Raw
  const found = (config?.collections ?? []).find(
    (raw: Raw) => String(raw?.name) === collection,
  )
  const entry = (found?.files ?? []).find((f: Raw) => String(f?.name) === file)
  return Array.isArray(entry?.fields) ? entry.fields.map(toField) : undefined
}
