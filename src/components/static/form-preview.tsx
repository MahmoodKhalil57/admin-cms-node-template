import { useWatch } from 'react-hook-form'
import { CornerDownRight, EyeOff } from 'lucide-react'

import { cn } from '#/lib/utils'

/**
 * The forms being declared, drawn as forms.
 *
 * The site preview beside the other collections cannot serve this one: the
 * template's sign-up form is markup baked into `index.html`, and nothing on the
 * page reads `admin-cms.json` at render time. Showing the site here would imply
 * that typing changes it, which is worse than showing no preview at all.
 *
 * So this previews what is actually being edited. It is a schematic rather than
 * a skin — it takes the panel's own colours, because promising the visitor's
 * exact typography would be the same lie one level down.
 */

interface Choice {
  value?: string
  label?: string
}

interface Field {
  name?: string
  label?: string
  type?: string
  required?: boolean
  placeholder?: string
  width?: string
  options?: Array<Choice>
  showWhen?: { field?: string; is?: string; value?: string }
}

interface FormDraft {
  slug?: string
  name?: string
  fields?: Array<Field>
  settings?: {
    confirmationMessage?: string
    submitLabel?: string
    spamProtection?: string
    retentionDays?: number
  }
}

const CONTROL =
  'border-border/80 bg-background text-muted-foreground/80 flex h-9 w-full items-center rounded-md border px-3 text-sm'

/** How a condition reads to someone who did not write it. */
function conditionText(when: NonNullable<Field['showWhen']>): string | null {
  if (!when.field) return null
  const target = when.field
  switch (when.is) {
    case 'filled':
      return `Shown when ${target} is filled in`
    case 'empty':
      return `Shown when ${target} is empty`
    case 'not_equal':
      return `Shown unless ${target} is “${when.value ?? ''}”`
    default:
      return `Shown when ${target} is “${when.value ?? ''}”`
  }
}

const FieldPreview = ({ field }: { field: Field }) => {
  const label = field.label || field.name || 'Untitled field'
  const type = field.type || 'text'
  const condition = field.showWhen ? conditionText(field.showWhen) : null

  const control = (() => {
    if (type === 'textarea')
      return (
        <div
          className={cn(CONTROL, 'h-16 items-start py-2')}
        >
          {field.placeholder || ''}
        </div>
      )
    if (type === 'checkbox')
      return (
        <div className="flex items-center gap-2">
          <span className="border-border/80 bg-background size-4 rounded-[4px] border" />
          <span className="text-muted-foreground/80 text-sm">{label}</span>
        </div>
      )
    if (type === 'select')
      return (
        <div className={cn(CONTROL, 'justify-between')}>
          <span>{field.options?.[0]?.label || 'Choose one'}</span>
          <span aria-hidden className="text-muted-foreground/50">
            ▾
          </span>
        </div>
      )
    return <div className={CONTROL}>{field.placeholder || ''}</div>
  })()

  return (
    <div
      className={cn(
        'min-w-0',
        field.width === 'half' ? 'sm:col-span-1' : 'col-span-full',
        // A conditional field is not always on the page, and the preview should
        // not pretend otherwise.
        condition && 'opacity-70',
      )}
    >
      {condition ? (
        <p className="text-muted-foreground/70 mb-1 flex items-center gap-1 text-[0.7rem]">
          <EyeOff className="size-3 shrink-0" />
          <span className="truncate">{condition}</span>
        </p>
      ) : null}
      {type === 'checkbox' ? (
        control
      ) : (
        <>
          <p className="mb-1 text-xs font-medium">
            {label}
            {field.required ? (
              <span className="text-primary ml-0.5" aria-hidden>
                *
              </span>
            ) : null}
          </p>
          {control}
        </>
      )}
    </div>
  )
}

const FormPreviewCard = ({ form }: { form: FormDraft }) => {
  const fields = form.fields ?? []
  const settings = form.settings ?? {}

  return (
    <div className="border-border/70 bg-card min-w-0 rounded-xl border p-4 shadow-sm">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-semibold">
          {form.name || (
            <span className="text-muted-foreground italic">Untitled form</span>
          )}
        </p>
        {form.slug ? (
          <span className="text-muted-foreground/70 shrink-0 font-mono text-[0.7rem]">
            /{form.slug}
          </span>
        ) : null}
      </div>

      {fields.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((field, index) => (
            <FieldPreview key={index} field={field} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground border-border/70 rounded-md border border-dashed px-3 py-6 text-center text-xs">
          Add a field and it appears here.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium">
          {settings.submitLabel || 'Submit'}
        </span>
        {settings.spamProtection && settings.spamProtection !== 'none' ? (
          <span className="text-muted-foreground/70 font-mono text-[0.7rem]">
            {settings.spamProtection}
          </span>
        ) : null}
        {settings.retentionDays ? (
          <span className="text-muted-foreground/70 text-[0.7rem]">
            deleted after {settings.retentionDays} days
          </span>
        ) : null}
      </div>

      {settings.confirmationMessage ? (
        <p className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs">
          <CornerDownRight className="mt-0.5 size-3 shrink-0" />
          <span>{settings.confirmationMessage}</span>
        </p>
      ) : null}
    </div>
  )
}

export const FormPreview = () => {
  const forms = (useWatch({ name: 'forms' }) ?? []) as Array<FormDraft>

  return (
    <div className="min-w-0 xl:sticky xl:top-6 xl:self-start">
      <div className="border-border/70 bg-muted/30 overflow-hidden rounded-xl border">
        <div className="border-border/70 flex items-center gap-2 border-b px-3 py-2">
          <span className="bg-primary size-1.5 rounded-full" />
          <span className="text-muted-foreground text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
            Form preview
          </span>
          <span className="text-muted-foreground/70 ml-auto text-[0.7rem]">
            {forms.length === 1 ? '1 form' : `${forms.length} forms`}
          </span>
        </div>
        <div className="max-h-[calc(100vh-12rem)] min-h-[16rem] overflow-y-auto p-3">
          {forms.length ? (
            <div className="flex flex-col gap-3">
              {forms.map((form, index) => (
                <FormPreviewCard key={index} form={form} />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground px-3 py-10 text-center text-xs">
              No forms yet. Add one and it appears here as you type.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
