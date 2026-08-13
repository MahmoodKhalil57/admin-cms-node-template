import { and, eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { formSubmissions, forms } from '#/db/schema'
import type { FormFieldDef } from '#/db/schema'
import type { NodeEnv } from './env'
import type { Principal } from './authz'
import { principalFrom } from './authz'
import { getEnabledFeatures } from './features'
import { resolveForm } from './form-fields'

/**
 * The forms somebody has to fill in before they can get on with anything.
 *
 * An operator marks a profile form "required", and from then on an account that
 * has not answered it is an account that cannot use the node. Not a banner, not
 * a nudge on one page — every authenticated call is refused until the answers
 * are there, because a nudge is a thing people click past and the whole reason
 * to ask at signup is to have the answer afterwards.
 *
 * Four things are deliberately still allowed through, and they are the reason
 * this is a gate rather than a trap:
 *
 * - `/api/me/profile`, which is how the answers arrive.
 * - `/api/auth/*`, so somebody can always sign out of an account they cannot use.
 * - the public endpoints, which serve strangers and must behave the same for a
 *   signed-in visitor as for anyone else.
 * - anything a key is asking for. A key acts as an account, and no account
 *   behind a key has a person at a keyboard to answer a form.
 *
 * The refusal carries the whole form — every field, and what is already
 * answered. A client that hits this has everything it needs to put the question
 * on screen without another call, which is what keeps the gate recoverable when
 * the thing it blocks is the panel that would otherwise fix it.
 */

export interface ProfileGap {
  slug: string
  name: string
  fields: Array<FormFieldDef>
  values: Record<string, unknown>
  missing: Array<string>
}

/** The required profile forms this person has not finished. */
export async function profileGaps(
  db: NodeDb,
  principal: Principal,
): Promise<Array<ProfileGap>> {
  // A key is not a person. Nothing to ask, and nobody to ask it of.
  if (principal.viaKey) return []
  if (!(await getEnabledFeatures(db)).includes('forms')) return []

  const required = await db
    .select()
    .from(forms)
    .where(
      and(
        eq(forms.target, 'profile'),
        eq(forms.requiredAtSignup, true),
        eq(forms.status, 'published'),
      ),
    )
  if (required.length === 0) return []

  const gaps: Array<ProfileGap> = []

  for (const form of required) {
    const [row] = await db
      .select()
      .from(formSubmissions)
      .where(
        and(
          eq(formSubmissions.formId, form.id),
          eq(formSubmissions.userId, principal.userId),
        ),
      )
      .limit(1)

    const values = (row?.data ?? {}) as Record<string, unknown>
    // Resolved against this person, so a field the node fills for itself is
    // never one they are held up by.
    const resolved = resolveForm(
      (form.fields ?? []) as Array<FormFieldDef>,
      principal,
    )
    const missing = resolved.fields
      .filter((field) => field.required && !field.readOnly)
      .filter((field) => {
        const value = values[field.name]
        return value === undefined || value === null || value === ''
      })
      .map((field) => field.name)

    if (missing.length === 0) continue

    gaps.push({
      slug: form.slug,
      name: form.name,
      fields: resolved.fields,
      values,
      missing,
    })
  }

  return gaps
}

export const PROFILE_INCOMPLETE = 'profile_incomplete'

/**
 * The gate itself: a response when this caller may not proceed, null when they
 * may — so a route reads `const held = await ...; if (held) return held` and
 * cannot accidentally continue past it.
 */
export async function profileRefusal(
  env: NodeEnv,
  db: NodeDb,
  request: Request,
): Promise<Response | null> {
  const principal = await principalFrom(env, db, request)
  // Anonymous callers are not held up. There is no account to complete, and the
  // endpoints that need one refuse for their own reasons.
  if (!principal) return null

  const gaps = await profileGaps(db, principal)
  if (gaps.length === 0) return null

  return Response.json(
    {
      error: 'Some account details are needed before you can carry on.',
      code: PROFILE_INCOMPLETE,
      forms: gaps,
    },
    { status: 403 },
  )
}
