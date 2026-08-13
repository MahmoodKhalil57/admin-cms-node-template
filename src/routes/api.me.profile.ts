import { createFileRoute } from '@tanstack/react-router'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { formSubmissions, forms } from '#/db/schema'
import type { FormFieldDef } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { allows, can, forbidden, principalFrom } from '#/server/authz'
import { missingRequired, resolveForm } from '#/server/form-fields'

/**
 * The signed-in person's own answers to the forms bound to accounts.
 *
 * A profile is a submission that belongs to somebody. That is the whole idea:
 * the same form builder, the same fields, the same validation — but one row per
 * person, edited rather than resent, and readable back to them.
 *
 * Which means none of the permission work is repeated here. Reading and writing
 * a profile is `submissions:read` and `submissions:write`, and the role that
 * ordinary members hold narrows those to `{ userId: { self: true } }`, so the
 * same WHERE clause that keeps a desk to one form keeps a member to one row.
 *
 * The owner of a row is never taken from the request. It is the session's, on
 * the way in and on the way out — a profile endpoint that accepted a user id
 * would be a way to write into somebody else's.
 */

interface Answers {
  [field: string]: unknown
}

function clean(fields: Array<FormFieldDef>, body: Answers): Answers {
  const allowed = new Set(fields.map((field) => field.name))
  const out: Answers = {}
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue
    out[key] = typeof value === 'string' ? value.trim() : value
  }
  return out
}

export const Route = createFileRoute('/api/me/profile')(
  serverRoute(
    {
      GET: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('forms')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const principal = await principalFrom(env, db, request)
        if (!principal) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (!can(principal, 'submissions:read'))
          return forbidden('submissions:read')

        const bound = await db
          .select()
          .from(forms)
          .where(
            and(eq(forms.target, 'profile'), eq(forms.status, 'published')),
          )

        const answers = await Promise.all(
          bound.map(async (form) => {
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

            // Resolved against them, so a field the node fills for itself never
            // appears as something they are being asked for.
            const resolved = resolveForm(
              (form.fields ?? []) as Array<FormFieldDef>,
              principal,
            )
            const values = {
              ...(row?.data ?? {}),
              ...resolved.filled,
            } as Answers
            return {
              id: form.id,
              slug: form.slug,
              name: form.name,
              fields: resolved.fields,
              requiredAtSignup: form.requiredAtSignup,
              values,
              // What the site needs to decide whether to stop and ask.
              complete: missingRequired(resolved, values).length === 0,
            }
          }),
        )

        return Response.json({ forms: answers })
      },

      PUT: async ({ request }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('forms')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }

        const principal = await principalFrom(env, db, request)
        if (!principal) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (!can(principal, 'submissions:write')) {
          return forbidden('submissions:write')
        }

        const body = (await request.json()) as {
          slug?: string
          values?: Answers
        }
        const [form] = await db
          .select()
          .from(forms)
          .where(
            and(
              eq(forms.slug, String(body.slug ?? '')),
              eq(forms.target, 'profile'),
            ),
          )
          .limit(1)
        if (!form) {
          return Response.json({ error: 'No such form.' }, { status: 404 })
        }

        const resolved = resolveForm(
          (form.fields ?? []) as Array<FormFieldDef>,
          principal,
        )
        // Only the fields they were shown are accepted; the rest are the node's
        // to say, and are written over the top once this passes.
        const askable = resolved.fields.filter((field) => !field.readOnly)
        const values = clean(askable, body.values ?? {})

        const absent = missingRequired(resolved, values)
        if (absent.length) {
          return Response.json(
            {
              error: 'Some answers are still needed.',
              fields: absent,
            },
            { status: 422 },
          )
        }

        // The row this write would produce, checked against the caller's own
        // narrowing before it is written — a grant scoped to `self` must refuse a
        // profile that is not theirs even though nothing here reads an id.
        const owned = { formId: form.id, userId: principal.userId }
        if (!allows(principal, 'submissions:write', owned)) {
          return forbidden('submissions:write')
        }

        Object.assign(values, resolved.filled)

        const [existing] = await db
          .select()
          .from(formSubmissions)
          .where(
            and(
              eq(formSubmissions.formId, form.id),
              eq(formSubmissions.userId, principal.userId),
            ),
          )
          .limit(1)

        // Edited, not resent: a profile is a fact about somebody, and keeping
        // every version of it would turn the submissions list into a diary.
        if (existing) {
          await db
            .update(formSubmissions)
            .set({ data: values })
            .where(eq(formSubmissions.id, existing.id))
        } else {
          await db.insert(formSubmissions).values({
            formId: form.id,
            userId: principal.userId,
            data: values,
            status: 'new',
          })
        }

        return Response.json({ ok: true, values })
      },
    },
    // Exempt from the profile gate: this is where the answers arrive
    { gate: 'none' },
  ),
)
