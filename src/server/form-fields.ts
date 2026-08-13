import type { FieldFill, FormFieldDef } from '#/db/schema'
import type { Principal } from './authz'

/**
 * What a form looks like to whoever is asking, and what the node fills in.
 *
 * One form, two shapes. A stranger opening the contact form is asked for their
 * address; a member is not, because the node already knows it and asking would
 * let them give somebody else's. The definition endpoint and the submission
 * endpoint both run this, from the same field list, so what is drawn and what is
 * accepted cannot drift apart.
 *
 * The order is the point. Fields are validated as the sender's, then the filled
 * values are written over the top — so a `fill` field's posted value is read,
 * checked, and then thrown away. There is no path where what arrived in the body
 * survives for a field the node answers itself.
 */

export interface ResolvedForm {
  /** what to draw, in order, with locked fields carrying their value */
  fields: Array<FormFieldDef & { value?: string; readOnly?: true }>
  /** field name -> the value the node substitutes, whatever was sent */
  filled: Record<string, string>
  /**
   * Fields that must be filled and could not be, because nobody is signed in.
   * A form carrying one is a form for members only.
   */
  unavailable: Array<string>
  /** whether the answer depends on who asked, and so must not be cached */
  viewerDependent: boolean
}

/** The fact a fill names, read off the principal. */
function factFor(fill: FieldFill, principal: Principal | null): string | null {
  if (!principal) return null
  switch (fill.from) {
    case 'user.email':
      return principal.email || null
    case 'user.name':
      return principal.name || null
    case 'user.id':
      return principal.userId || null
    default:
      return null
  }
}

export function resolveForm(
  definition: Array<FormFieldDef>,
  principal: Principal | null,
): ResolvedForm {
  const fields: ResolvedForm['fields'] = []
  const filled: Record<string, string> = {}
  const unavailable: Array<string> = []
  let viewerDependent = false

  for (const field of definition) {
    const fill = field.fill
    if (!fill) {
      fields.push(field)
      continue
    }

    // Whether the answer would differ for someone else — true even when this
    // particular caller is anonymous, because the next one may not be.
    viewerDependent = true

    const fact = factFor(fill, principal)

    if (fact === null) {
      if ((fill.when ?? 'signed-in') === 'always') {
        // The node is the only acceptable source for this value and has none.
        // Asking the sender for it would defeat the reason it was declared.
        unavailable.push(field.name)
        continue
      }
      // Fall back to asking, which is the ordinary case: a contact form open to
      // strangers that stops asking members for what it already knows.
      fields.push(field)
      continue
    }

    filled[field.name] = fact
    if ((fill.display ?? 'hidden') === 'locked') {
      // Shown, in place, and not editable — worth the space for a value the
      // sender should see before they send it.
      fields.push({ ...field, value: fact, readOnly: true, required: false })
    }
  }

  return { fields, filled, unavailable, viewerDependent }
}

/** Required fields of a resolved form that the answers do not cover. */
export function missingRequired(
  resolved: ResolvedForm,
  answers: Record<string, unknown>,
): Array<string> {
  return resolved.fields
    .filter((field) => field.required && !field.readOnly)
    .filter((field) => {
      const value = answers[field.name]
      return value === undefined || value === null || value === ''
    })
    .map((field) => field.name)
}
