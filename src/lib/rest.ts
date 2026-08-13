import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  like,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  automations,
  features,
  formSubmissions,
  forms,
  invitations,
  notifications,
  roles,
} from '#/db/schema'
import { RESOURCE_PERMISSIONS } from '#/lib/permission-catalog'
import type { Principal } from '#/server/authz'
import { can, conditionFor, forbidden, matchesCondition } from '#/server/authz'

/**
 * A generic REST layer speaking ra-data-simple-rest's dialect, so the admin's
 * dataProvider stays configuration rather than bespoke code.
 *
 * Only the tables listed here are reachable. Anything else is a 404 — the route
 * takes a resource name straight from the URL, so this map is the boundary that
 * stops it addressing an arbitrary table.
 *
 * `feature` is the second half of feature gating. The admin UI omits a
 * `<Resource>` whose feature is off, but that only hides it; without this check
 * the rows stay readable over HTTP.
 */
const RESOURCES = {
  // `feature: null` means always available. The features table itself must be,
  // or switching one off would take away the means to switch it back on.
  features: { table: features, feature: null },
  forms: { table: forms, feature: 'forms' },
  submissions: { table: formSubmissions, feature: 'forms' },
  automations: { table: automations, feature: 'forms' },
  notifications: { table: notifications, feature: 'forms' },
  roles: { table: roles, feature: 'user-management' },
  invitations: { table: invitations, feature: 'user-management' },
}

// Drizzle's table types are heavily generic; the generic handlers below work
// over any of them, so the shared shape is deliberately loose.
/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseTable = any

function resolveResource(resource: string, enabled: Array<string>) {
  if (!Object.prototype.hasOwnProperty.call(RESOURCES, resource)) return null
  const entry = RESOURCES[resource as keyof typeof RESOURCES]
  if (entry.feature === null) return entry.table
  // A disabled feature is indistinguishable from a resource that does not
  // exist, on purpose — a node should not advertise what it is not running.
  if (!enabled.includes(entry.feature)) return null
  return entry.table
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function notFound(resource: string) {
  return Response.json(
    { error: `Unknown resource "${resource}"` },
    { status: 404 },
  )
}

/**
 * Translates react-admin's `filter` object into SQL. Arrays become `IN` (which
 * is how getMany and getManyReference arrive), strings on text columns become
 * partial matches so the filter inputs behave like search, and everything else
 * is exact equality. Unknown keys are ignored rather than erroring, because
 * react-admin sends its own bookkeeping fields through the same object.
 */
/**
 * A narrowed grant, as SQL.
 *
 * Applied to the query rather than to its results, so the count and the pages
 * agree with what the reader may actually see. Filtering afterwards would leave
 * a list claiming forty submissions and showing three.
 */
function conditionWhere(
  table: LooseTable,
  principal: Principal,
  permission: string,
): SQL | undefined {
  const condition = conditionFor(principal, permission)
  if (!condition) return undefined

  const columns = getTableColumns(table)
  const parts: Array<SQL> = []

  for (const [field, rule] of Object.entries(condition)) {
    const column = columns[field]
    if (!column) continue
    if (rule.self) parts.push(eq(column, principal.userId))
    else if (rule.eq !== undefined) parts.push(eq(column, rule.eq))
    else if (rule.in?.length) parts.push(inArray(column, rule.in))
  }

  return parts.length > 0 ? and(...parts) : undefined
}

/** What this call needs, and whether the caller has it. */
function guard(
  resource: string,
  action: 'read' | 'write' | 'delete',
  principal: Principal | null,
): { ok: true; permission: string } | { ok: false; response: Response } {
  const required = RESOURCE_PERMISSIONS[resource]
  // A resource nobody thought to map is refused rather than opened: forgetting
  // an entry should cost a 403, not everything behind it.
  const permission = required?.[action] ?? required?.write
  if (!permission) {
    return { ok: false, response: forbidden(`${resource}:${action}`) }
  }
  if (!can(principal, permission)) {
    return { ok: false, response: forbidden(permission) }
  }
  return { ok: true, permission }
}

function buildWhere(
  table: LooseTable,
  filter: Record<string, unknown>,
): SQL | undefined {
  const columns = getTableColumns(table)
  const conditions: Array<SQL> = []

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue
    const column = columns[key]
    if (!column) continue

    if (Array.isArray(value)) {
      if (value.length === 0) continue
      conditions.push(inArray(column, value))
    } else if (typeof value === 'string' && column.dataType === 'string') {
      conditions.push(like(column, `%${value}%`))
    } else {
      conditions.push(eq(column, value))
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}

export async function listResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  url: URL,
  principal: Principal | null,
) {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'read', principal)
  if (!allowed.ok) return allowed.response

  const columns = getTableColumns(table as LooseTable)
  const filter = parseJson<Record<string, unknown>>(
    url.searchParams.get('filter'),
    {},
  )
  const [sortField, sortOrder] = parseJson<[string, string]>(
    url.searchParams.get('sort'),
    ['id', 'ASC'],
  )
  const [start, end] = parseJson<[number, number]>(
    url.searchParams.get('range'),
    [0, 24],
  )

  const where = and(
    buildWhere(table, filter),
    conditionWhere(table, principal!, allowed.permission),
  )
  const sortColumn = columns[sortField] ?? columns.id
  const direction = String(sortOrder).toUpperCase() === 'DESC' ? desc : asc

  const rows = await db
    .select()
    .from(table as LooseTable)
    .where(where)
    .orderBy(direction(sortColumn))
    .limit(Math.max(1, end - start + 1))
    .offset(Math.max(0, start))

  const [totals] = await db
    .select({ total: count() })
    .from(table as LooseTable)
    .where(where)
  const total = totals?.total ?? 0

  // react-admin reads the total from Content-Range; without exposing the header
  // it is invisible to the browser whenever the API is not same-origin.
  return Response.json(rows, {
    headers: {
      'Content-Range': `${resource} ${start}-${start + Math.max(0, rows.length - 1)}/${total}`,
      'Access-Control-Expose-Headers': 'Content-Range',
    },
  })
}

export async function getResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  id: string,
  principal: Principal | null,
) {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'read', principal)
  if (!allowed.ok) return allowed.response

  const columns = getTableColumns(table as LooseTable)
  const [row] = await db
    .select()
    .from(table as LooseTable)
    .where(eq(columns.id, Number(id)))
    .limit(1)

  if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
  // Outside a narrowed grant the record is not forbidden, it is absent: saying
  // "you may not see submission 41" still says submission 41 exists.
  if (!matchesCondition(conditionFor(principal, allowed.permission), row, principal!)) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  return Response.json(row)
}

export async function createResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  request: Request,
  principal: Principal | null,
) {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'write', principal)
  if (!allowed.ok) return allowed.response

  const body = (await request.json()) as Record<string, unknown>
  // Checked on the way in as well as the way out: a grant narrowed to one form
  // that still let you file rows against another would not be narrowed at all.
  if (!matchesCondition(conditionFor(principal, allowed.permission), body, principal!)) {
    return forbidden(allowed.permission)
  }
  const rows = (await db
    .insert(table as LooseTable)
    .values(stripReadOnly(table, body))
    .returning()) as Array<Record<string, unknown>>

  return Response.json(rows[0], { status: 201 })
}

export async function updateResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  id: string,
  request: Request,
  principal: Principal | null,
) {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'write', principal)
  if (!allowed.ok) return allowed.response

  const columns = getTableColumns(table as LooseTable)
  const body = (await request.json()) as Record<string, unknown>
  const rows = (await db
    .update(table as LooseTable)
    .set(stripReadOnly(table, body))
    // The narrowing rides on the WHERE, so a row outside the grant simply is
    // not found — no read-then-write gap for it to slip through.
    .where(
      and(
        eq(columns.id, Number(id)),
        conditionWhere(table, principal!, allowed.permission),
      ),
    )
    .returning()) as Array<Record<string, unknown>>

  if (!rows[0]) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(rows[0])
}

export async function deleteResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  id: string,
  principal: Principal | null,
) {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'delete', principal)
  if (!allowed.ok) return allowed.response

  const columns = getTableColumns(table as LooseTable)
  const rows = (await db
    .delete(table as LooseTable)
    .where(
      and(
        eq(columns.id, Number(id)),
        conditionWhere(table, principal!, allowed.permission),
      ),
    )
    .returning()) as Array<Record<string, unknown>>

  if (!rows[0]) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(rows[0])
}

/**
 * Drops keys that are not real columns, plus the primary key and any
 * server-owned timestamp. react-admin round-trips the whole record on update,
 * so without this an edit would try to write `id` and `created_at` back.
 */
function stripReadOnly(table: LooseTable, body: Record<string, unknown>) {
  const columns = getTableColumns(table)
  const values: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(body)) {
    if (key === 'id' || key === 'createdAt') continue
    if (!columns[key]) continue
    values[key] = value
  }

  return values
}
