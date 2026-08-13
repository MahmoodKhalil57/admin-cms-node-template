import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import type { NodeEnv } from './env'
import { runAutomations } from './automations'
import { formSubmissions, forms } from '#/db/schema'
import type { FormFieldDef } from '#/db/schema'
import { principalFrom } from './authz'
import { resolveForm } from './form-fields'

/**
 * The public face of a form: what an anonymous visitor's browser may see and
 * send.
 *
 * The guiding rule is that the frontend may *show* anything but may not be the
 * *authority* on anything. A form's id is public by design — like a Web3Forms
 * access key, it identifies a form without authorising anything — so abuse is
 * handled by validation and (later) quotas, not by keeping the slug secret.
 */

/**
 * CORS for the public endpoints only.
 *
 * `*` is the default because a static site can be served from anywhere and
 * `Origin` is trivially forged by non-browser clients, so treating it as a
 * security control would be theatre. `ALLOWED_ORIGINS` narrows it when a node
 * knows its own site's address.
 */
export function corsHeaders(
  allowedOrigins: string | undefined,
  origin: string | null,
): Record<string, string> {
  const allow = (allowedOrigins ?? '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const wildcard = allow.includes('*')
  const permitted = wildcard || (origin !== null && allow.includes(origin))

  if (!permitted) return {}

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': wildcard ? '*' : origin!,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  }

  // Cookies only travel to an origin named outright — the browser refuses to
  // send them to `*`, and so it should. A site on its own domain is same-origin
  // with the node and never reaches this; a site elsewhere has to be listed
  // before the node will recognise its visitors as signed in. Until it is, a
  // form with session-filled fields simply shows its signed-out shape, which is
  // the safe way to be misconfigured.
  if (!wildcard) headers['Access-Control-Allow-Credentials'] = 'true'

  return headers
}

export function preflight(cors: Record<string, string>): Response {
  return Object.keys(cors).length > 0
    ? new Response(null, { status: 204, headers: cors })
    : new Response('Origin not allowed', { status: 403 })
}

/**
 * The form definition a public page needs in order to render itself.
 *
 * Resolved against whoever is asking, so the page has no decisions of its own to
 * make: it draws the fields it is given. A stranger and a member get different
 * lists from the same form, and neither of them gets a rule to interpret.
 */
export async function publicFormDefinition(
  env: NodeEnv,
  db: NodeDb,
  slug: string,
  request: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const [form] = await db
    .select()
    .from(forms)
    .where(eq(forms.slug, slug))
    .limit(1)

  if (!form) {
    return Response.json({ error: 'Unknown form' }, { status: 404, headers: cors })
  }
  // A paused form is deliberately distinct from a missing one: the page can say
  // "this is closed" rather than "this never existed".
  if (form.status === 'paused') {
    return Response.json({ error: 'This form is closed' }, { status: 410, headers: cors })
  }
  if (form.status !== 'published') {
    return Response.json({ error: 'Unknown form' }, { status: 404, headers: cors })
  }

  const principal = await principalFrom(env, db, request)
  const resolved = resolveForm((form.fields ?? []) as Array<FormFieldDef>, principal)

  if (resolved.unavailable.length > 0) {
    // Every field on this form the node must answer itself, and no account to
    // answer them from. Not a validation failure — there is nothing the sender
    // could have typed that would have helped.
    return Response.json(
      { error: 'Sign in to use this form.', code: 'sign_in_required' },
      { status: 401, headers: cors },
    )
  }

  const headers: Record<string, string> = { ...cors }
  if (resolved.viewerDependent) {
    // Two people must not be served each other's copy of this. `Vary: Cookie`
    // says so to anything in between; `private, no-store` says it again to the
    // ones that would ignore it.
    headers['Cache-Control'] = 'private, no-store'
    headers.Vary = headers.Vary ? `${headers.Vary}, Cookie` : 'Cookie'
  }

  return Response.json(
    {
      slug: form.slug,
      name: form.name,
      fields: resolved.fields,
      successMessage: form.successMessage ?? 'Thanks — we got it.',
      /** whether the node recognised the asker, so a page can say so */
      signedIn: Boolean(principal),
    },
    { headers },
  )
}

/**
 * Reads a submission body.
 *
 * Accepts JSON, url-encoded and multipart so a page can post whichever suits
 * it. Multipart in particular is a CORS-safe content type, so a browser skips
 * the preflight round trip that JSON forces on every submission.
 */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return (await request.json()) as Record<string, unknown>
  }

  const form = await request.formData()
  const values: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') values[key] = value
  }
  return values
}

const MAX_VALUE_LENGTH = 4000

export async function acceptSubmission(
  env: NodeEnv,
  db: NodeDb,
  slug: string,
  request: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const [form] = await db
    .select()
    .from(forms)
    .where(eq(forms.slug, slug))
    .limit(1)

  if (!form) {
    return Response.json({ error: 'Unknown form' }, { status: 404, headers: cors })
  }
  if (form.status === 'paused') {
    return Response.json({ error: 'This form is closed' }, { status: 410, headers: cors })
  }
  if (form.status !== 'published') {
    return Response.json({ error: 'Unknown form' }, { status: 404, headers: cors })
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(request)
  } catch {
    return Response.json({ error: 'Malformed body' }, { status: 400, headers: cors })
  }

  // A filled honeypot means a bot: answer as though it worked, so it has
  // nothing to learn from the difference.
  if (typeof body._hp === 'string' && body._hp.trim() !== '') {
    return Response.json(
      { success: true, message: form.successMessage ?? 'Thanks — we got it.' },
      { headers: cors },
    )
  }

  const principal = await principalFrom(env, db, request)
  const resolved = resolveForm((form.fields ?? []) as Array<FormFieldDef>, request ? principal : null)

  if (resolved.unavailable.length > 0) {
    return Response.json(
      { success: false, error: 'Sign in to use this form.', code: 'sign_in_required' },
      { status: 401, headers: cors },
    )
  }

  // Only what this sender was actually shown. A field the node fills is not in
  // this list, so nothing they posted under its name is even looked at.
  const definition = resolved.fields.filter((field) => !field.readOnly)
  const errors: Record<string, string> = {}
  const data: Record<string, unknown> = {}

  for (const field of definition) {
    const raw = body[field.name]
    const value = typeof raw === 'string' ? raw.trim() : raw

    if (field.required && (value === undefined || value === null || value === '')) {
      errors[field.name] = `${field.label || field.name} is required.`
      continue
    }
    if (value === undefined || value === null || value === '') continue

    if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
      errors[field.name] = `${field.label || field.name} is too long.`
      continue
    }
    if (
      field.type === 'email' &&
      typeof value === 'string' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ) {
      errors[field.name] = 'That does not look like an email address.'
      continue
    }

    data[field.name] = value
  }

  if (Object.keys(errors).length > 0) {
    return Response.json({ success: false, errors }, { status: 422, headers: cors })
  }

  // Last, and over the top of everything. Whatever arrived under these names has
  // now been read and discarded; what is stored is what the node knows.
  Object.assign(data, resolved.filled)

  const [saved] = await db
    .insert(formSubmissions)
    .values({
      formId: form.id,
      data,
      status: 'new',
      // An enquiry from someone signed in belongs to them, which is what lets a
      // role narrowed to `self` show a person their own history.
      userId: principal && !principal.viaKey ? principal.userId : null,
    })
    .returning()

  // Whoever asked to hear about this, told now. Never allowed to fail the
  // submission: losing a notification is recoverable, losing what the visitor
  // typed is not.
  await runAutomations(
    env,
    db,
    'submission.created',
    { ...saved, data },
    { formName: form.name },
  )

  return Response.json(
    { success: true, message: form.successMessage ?? 'Thanks — we got it.' },
    { headers: cors },
  )
}
