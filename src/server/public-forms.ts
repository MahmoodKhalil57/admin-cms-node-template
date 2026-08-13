import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import type { NodeEnv } from './env'
import { runAutomations } from './automations'
import { formSubmissions, forms } from '#/db/schema'
import type { FormFieldDef } from '#/db/schema'

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

  const permitted =
    allow.includes('*') || (origin !== null && allow.includes(origin))

  if (!permitted) return {}

  return {
    'Access-Control-Allow-Origin': allow.includes('*') ? '*' : origin!,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  }
}

export function preflight(cors: Record<string, string>): Response {
  return Object.keys(cors).length > 0
    ? new Response(null, { status: 204, headers: cors })
    : new Response('Origin not allowed', { status: 403 })
}

/** The form definition a public page needs in order to render itself. */
export async function publicFormDefinition(
  db: NodeDb,
  slug: string,
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

  return Response.json(
    {
      slug: form.slug,
      name: form.name,
      fields: form.fields,
      successMessage: form.successMessage ?? 'Thanks — we got it.',
    },
    { headers: cors },
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

  const definition = (form.fields ?? []) as Array<FormFieldDef>
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

  const [saved] = await db
    .insert(formSubmissions)
    .values({ formId: form.id, data, status: 'new' })
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
