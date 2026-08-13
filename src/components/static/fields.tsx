import { useState } from 'react'
import { useWatch } from 'react-hook-form'
import { useSimpleFormIteratorItem, useWrappedSource } from 'ra-core'
import { ChevronRight } from 'lucide-react'

import {
  ArrayInput,
  BooleanField,
  BooleanInput,
  DataTable,
  NumberInput,
  SelectInput,
  SimpleFormIterator,
  TextField,
  TextInput,
} from '#/components/admin'
import { cn } from '#/lib/utils'

/**
 * Sveltia widgets rendered with the kit's inputs.
 *
 * The mapping is deliberately small. Every widget the template uses is here;
 * anything unfamiliar falls back to a text input rather than failing to render,
 * so an unknown config still opens and stays editable — losing formatting is
 * recoverable, refusing to load the page is not.
 *
 * Two rules shape how it looks, and both come from the content rather than from
 * taste:
 *
 *   Identifiers are set in mono. A field's `name`, a form's `slug` and a
 *   condition's target are machine-facing — they become JSON keys and URL
 *   segments — so they are set in the face the site's own code uses. Prose
 *   stays in the body face.
 *
 *   A list of objects collapses to one line per item. The alternative is what
 *   this file used to do: render every input of every item at once, which for
 *   a form field means eight controls, most of which do not apply. The row
 *   summarises itself from its own values and opens on demand.
 */
export interface StaticField {
  name: string
  label: string
  widget: string
  required: boolean
  hint?: string
  options?: Array<string>
  fields?: Array<StaticField>
  /** identifier rather than prose — set in mono */
  mono?: boolean
  /** only shown when a sibling holds one of these values */
  condition?: { field: string; value: Array<string> }
}

/**
 * A field that only applies in some cases.
 *
 * `Choices` is meaningless on a text field, but it was drawn on every field
 * anyway, captioned "Only for a Select field" — an instruction to ignore it.
 * Reading the sibling it depends on and drawing nothing is the better answer.
 */
const When = ({
  condition,
  children,
}: {
  condition: { field: string; value: Array<string> }
  children: React.ReactNode
}) => {
  const sibling = useWatch({ name: useWrappedSource(condition.field) })
  return condition.value.includes(String(sibling ?? '')) ? <>{children}</> : null
}

/** A named group of related inputs, e.g. a form's settings. */
const Group = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) => (
  <fieldset className="border-border/70 bg-muted/30 min-w-0 rounded-lg border p-4">
    <legend className="text-muted-foreground px-1.5 text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
      {label}
    </legend>
    {hint ? (
      <p className="text-muted-foreground mb-3 text-xs">{hint}</p>
    ) : null}
    <div className="flex min-w-0 flex-col gap-4">{children}</div>
  </fieldset>
)

/**
 * The best field to title a row with.
 *
 * A field actually named as the title wins, because the first piece of prose in
 * an item is often not its title — a catalog item leads with its lot number, so
 * picking positionally titled every row `01`, `02`, `03`.
 */
const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'question', 'summary']

function titleFieldOf(fields: Array<StaticField>): StaticField | undefined {
  const prose = (field: StaticField) =>
    !field.mono && ['string', 'text'].includes(field.widget)

  for (const key of TITLE_KEYS) {
    const named = fields.find((field) => field.name === key && prose(field))
    if (named) return named
  }
  return fields.find(prose) ?? fields[0]
}

/**
 * One item of a list, titled by its own contents.
 *
 * The heading is live: typing a label retitles the row as you go, so a long
 * list stays readable while it is being edited.
 *
 * Rows are numbered because for this content the order is meaningful — a form's
 * fields appear on the page in the order they sit here.
 */
const ListRow = ({
  fields,
  depth,
}: {
  fields: Array<StaticField>
  depth: number
}) => {
  const { index } = useSimpleFormIteratorItem()
  const [open, setOpen] = useState(false)

  const titleField = titleFieldOf(fields)
  const monoField = fields.find((f) => f.mono)
  const badgeField = fields.find((f) => f.widget === 'select' && !f.condition)

  // Hooks cannot be called conditionally, so every row watches all three slots
  // and simply renders nothing for the ones this collection does not have.
  // A missing slot must still call its hook, but an empty source resolves to
  // the item itself — so the value is discarded unless the field exists.
  const titleValue = useWatch({ name: useWrappedSource(titleField?.name ?? '') })
  const monoValue = useWatch({ name: useWrappedSource(monoField?.name ?? '') })
  const badgeValue = useWatch({ name: useWrappedSource(badgeField?.name ?? '') })
  const title = titleField ? titleValue : undefined
  const mono = monoField ? monoValue : undefined
  const badge = badgeField ? badgeValue : undefined

  const untitled = `Item ${index + 1}`

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        className="focus-visible:ring-ring/60 hover:bg-accent/40 -mx-1.5 flex w-full min-w-0 items-center gap-3 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <span className="text-muted-foreground/70 w-5 shrink-0 font-mono text-xs tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {String(title || '') || (
            <span className="text-muted-foreground italic">{untitled}</span>
          )}
        </span>
        {mono ? (
          <span className="text-muted-foreground hidden shrink-0 font-mono text-xs sm:inline">
            {String(mono)}
          </span>
        ) : null}
        {badge ? (
          <span className="border-border/70 bg-background text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.7rem]">
            {String(badge)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="border-border/60 mt-3 flex min-w-0 flex-col gap-4 border-t pt-4">
          {fields.map((child) => inputFor(child, '', depth + 1))}
        </div>
      ) : null}
    </div>
  )
}

export function inputFor(
  field: StaticField,
  prefix = '',
  depth = 0,
): React.ReactElement {
  const source = prefix ? `${prefix}.${field.name}` : field.name
  const shared = {
    key: source,
    source,
    label: field.label,
    helperText: field.hint,
    // Scoped to the control: the label and hint beside it are prose.
    className: field.mono ? '[&_input]:font-mono [&_textarea]:font-mono' : undefined,
  }

  const rendered = ((): React.ReactElement => {
    switch (field.widget) {
      // Carried by the file, not edited here. It still survives a save, because
      // writes merge rather than replace — so `$schema` and friends stay put
      // without cluttering the form.
      case 'hidden':
        return <></>
      case 'text':
        return <TextInput {...shared} multiline />
      case 'number':
        return <NumberInput {...shared} />
      case 'boolean':
        return <BooleanInput {...shared} />
      case 'select':
        return (
          <SelectInput
            {...shared}
            choices={(field.options ?? []).map((option) => ({
              id: option,
              name: option,
            }))}
          />
        )
      case 'image':
        // A path into the repo's media folder, which the site resolves itself.
        return (
          <TextInput
            {...shared}
            className="[&_input]:font-mono"
            helperText={field.hint ?? 'Path to an image in the repo'}
          />
        )
      case 'object':
        return (
          <Group key={source} label={field.label} hint={field.hint}>
            {(field.fields ?? []).map((child) => inputFor(child, source, depth))}
          </Group>
        )
      case 'list':
        return field.fields?.length ? (
          <div key={source} className="flex min-w-0 flex-col gap-2">
            <div>
              <p className="text-sm font-medium">{field.label}</p>
              {field.hint ? (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {field.hint}
                </p>
              ) : null}
            </div>
            <ArrayInput
              {...shared}
              label={false}
              helperText={false}
              className="min-w-0">
            {/* Stacked, never inline: an inline row divides the width by the
                number of inputs, which for a form field left every label
                wrapping one character per line. */}
            <SimpleFormIterator
              // Removing every item at once is not something anyone reaches
              // for on a list of forms, and it was the loudest control here.
              disableClear
              className={cn(
                '[&>ul]:gap-2',
                '[&>ul>li]:border-border/70 [&>ul>li]:rounded-lg [&>ul>li]:border [&>ul>li]:px-3 [&>ul>li]:py-2 [&>ul>li]:border-b',
                depth === 0 ? '[&>ul>li]:bg-card' : '[&>ul>li]:bg-background/40',
                // Reorder and remove are secondary to reading the row, so they
                // sit quiet until pointed at. Remove still turns red — on
                // approach rather than at rest.
                '[&_.simple-form-iterator-item-actions_button]:!text-muted-foreground',
                '[&_.simple-form-iterator-item-actions_svg]:!text-current',
                '[&_.simple-form-iterator-item-actions_button:hover]:!text-foreground',
                '[&_.simple-form-iterator-item-actions_button:last-child:hover]:!text-destructive',
              )}
            >
              <ListRow fields={field.fields} depth={depth} />
            </SimpleFormIterator>
            </ArrayInput>
          </div>
        ) : (
          // A list with no declared shape is a list of plain strings.
          <ArrayInput {...shared} className="min-w-0">
            <SimpleFormIterator inline>
              <TextInput source="" label={field.label} />
            </SimpleFormIterator>
          </ArrayInput>
        )
      default:
        return <TextInput {...shared} />
    }
  })()

  if (!field.condition) return rendered
  return (
    <When key={source} condition={field.condition}>
      {rendered}
    </When>
  )
}

/** The columns worth showing in a list — scalars only, in declared order. */
export function columnsFor(fields: Array<StaticField>): React.ReactNode {
  const scalar = fields
    .filter((field) => !['list', 'object', 'hidden'].includes(field.widget))
    .slice(0, 4)

  return (
    <>
      {scalar.map((field) =>
        field.widget === 'boolean' ? (
          <DataTable.Col key={field.name} source={field.name} label={field.label}>
            <BooleanField source={field.name} />
          </DataTable.Col>
        ) : (
          <DataTable.Col key={field.name} source={field.name} label={field.label}>
            <TextField source={field.name} className={field.mono ? 'font-mono' : undefined} />
          </DataTable.Col>
        ),
      )}
    </>
  )
}
