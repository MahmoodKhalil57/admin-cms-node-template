/**
 * What a form field is, with no database attached.
 *
 * Split out of the schema because both sides need it and only one of them
 * should pay for it. The panel draws these, the site draws these, and the
 * server validates against them — but importing them from `#/db/schema` drags
 * Drizzle and every table definition into whichever bundle asked, which is how
 * a query builder ended up being downloaded by a browser that will never run a
 * query. Re-exported from the schema, so existing imports keep working.
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
  /** the node answers this one itself when it can — see `FieldFill` */
  fill?: FieldFill
}

/**
 * A field the node fills in rather than asks for.
 *
 * The case that motivates it: a contact form wants an email address. From a
 * stranger there is no choice but to ask. From someone signed in, asking is
 * both a worse experience and a worse answer — they can type anybody's address,
 * and the one thing the node already knows for certain is theirs.
 *
 * So the field says where its value comes from, and the node substitutes it.
 * WPForms and Gravity Forms express the same idea as a smart tag (`{user_email}`)
 * placed in a field's default value, usually with the field set read-only. The
 * difference here is where the substitution happens. A default value is filled
 * in the browser, so read-only is a styling choice and the posted value is still
 * whatever the sender decided. This is resolved on the way in, after validation,
 * from the session — the posted value for a filled field is discarded unread.
 * Read-only in a page is a courtesy; this is the guarantee behind it.
 *
 * `when` is what makes one form serve both visitors. `signed-in` means "fill it
 * if you can, otherwise ask" — the contact form that shows three fields to a
 * stranger and two to a member. `always` means the value is never the sender's
 * to give, so a form carrying one is for members only and refuses anyone else.
 */
export interface FieldFill {
  /** the fact the node substitutes */
  from: 'user.email' | 'user.name' | 'user.id'
  /**
   * `signed-in` — fill for those who are, ask everyone else.
   * `always` — fill it or refuse the submission.
   */
  when?: 'signed-in' | 'always'
  /**
   * What the sender sees once it is being filled. `hidden` drops the field from
   * the form entirely; `locked` shows it with the value in place and not
   * editable, which is worth the space when the value is one they should check.
   */
  display?: 'hidden' | 'locked'
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

