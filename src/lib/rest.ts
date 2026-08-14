import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  like,
  not,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  automations,
  features,
  formSubmissions,
  forms,
  invitations,
  events,
  notifications,
  orders as ordersTable,
  products as productsTable,
  projects as projectsTable,
  vendors as vendorsTable,
  policies,
  roles,
} from '#/db/schema'
import type { RoleCondition } from '#/db/schema'
import { ALWAYS_ON } from '#/lib/feature-catalog'
import { RESOURCE_PERMISSIONS } from '#/lib/permission-catalog'
import type { Principal } from '#/server/authz'
import { allowedWays, allows, can, deniedWays, forbidden } from '#/server/authz'
import { record } from '#/server/events'

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
  policies: { table: policies, feature: 'user-management' },
  invitations: { table: invitations, feature: 'user-management' },
  // Written by the node, never by a caller — see `readOnly` in `guard`.
  events: { table: events, feature: 'instrumentation', readOnly: true },
  vendors: { table: vendorsTable, feature: 'vendors' },
  // An order is what a provider said happened. Readable, never editable —
  // a refund is an action taken through the provider, not a status typed in.
  orders: { table: ordersTable, feature: 'payments', readOnly: true },
  products: { table: productsTable, feature: 'payments' },
  // Created by the provisioning route, never by a POST — a row here without
  // infrastructure behind it is a project that does not exist.
  projects: { table: projectsTable, feature: 'projects', readOnly: true },
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
 * One condition as SQL: every field it names, all of which must hold.
 *
 * A field the table does not have is skipped rather than treated as false,
 * because a condition written for submissions must not silently empty a list of
 * forms. Which is safe only because the caller decides what an all-skipped
 * condition means — see below.
 */
function conditionSql(
  table: LooseTable,
  condition: RoleCondition,
  principal: Principal,
): SQL | undefined {
  const columns = getTableColumns(table)
  const parts: Array<SQL> = []

  for (const [field, rule] of Object.entries(condition)) {
    const column = columns[field]
    if (!column) continue
    if (rule.mine) {
      // An account that acts for no vendor matches no row. Said explicitly
      // because `IN ()` is not valid SQL and would otherwise have to be
      // special-cased somewhere less obvious.
      parts.push(
        principal.vendorIds.length
          ? inArray(column, principal.vendorIds)
          : sql`1 = 0`,
      )
    } else if (rule.self) parts.push(eq(column, principal.userId))
    else if (rule.eq !== undefined) parts.push(eq(column, rule.eq))
    else if (rule.in?.length) parts.push(inArray(column, rule.in))
  }

  return parts.length > 0 ? and(...parts) : undefined
}

/**
 * The narrowing this caller's grant puts on a query.
 *
 * Applied to the query rather than to its results, so the count and the pages
 * agree with what the reader may actually see. Filtering afterwards would leave
 * a list claiming forty submissions and showing three.
 *
 * Allows are OR-ed: two policies each naming a desk give a role that reaches
 * both, and AND-ing them would give one that reaches neither. Denies are
 * negated and AND-ed, so a hole carved in a grant stays carved whatever else
 * widens it.
 *
 * A deny against a column holding NULL excludes the row — `NOT (x = 1)` is NULL
 * when `x` is, and SQL keeps only rows that are true. That is the safe way to
 * be wrong: an anonymous submission disappears from a list it might have been
 * allowed in, rather than appearing in one it was meant to be kept out of.
 */
function conditionWhere(
  table: LooseTable,
  principal: Principal,
  permission: string,
): SQL | undefined {
  const parts: Array<SQL> = []

  // Each group is a separate narrowing that has to hold, so they are ANDed;
  // the alternatives inside one are ORed. Two authorities, two groups, and no
  // way for the second to widen the first.
  for (const group of allowedWays(principal, permission)) {
    const ways = group
      .map((way) => conditionSql(table, way, principal))
      .filter((part): part is SQL => part !== undefined)

    // Every alternative named something this table has not got. This narrowing
    // is to records that cannot exist here, so nothing matches — refused,
    // rather than quietly dropped, which would open the whole table.
    if (ways.length === 0) return sql`1 = 0`
    parts.push(ways.length === 1 ? ways[0]! : or(...ways)!)
  }

  for (const way of deniedWays(principal, permission)) {
    const part = conditionSql(table, way, principal)
    // A denial this table cannot express is not a denial of everything: it
    // names records that do not live here.
    if (part) parts.push(not(part))
  }

  if (parts.length === 0) return undefined
  return parts.length === 1 ? parts[0] : and(...parts)
}

/**
 * Refuses to switch off something that is part of what a node is.
 *
 * A node exists to be the back end of a website, to take money, and to know who
 * may do what. Turning any of those off does not make a smaller node, it makes
 * a broken one — and the ability to do it was never a capability anybody asked
 * for, only a consequence of the catalog treating every feature alike.
 */
function lockedFeature(
  resource: string,
  body: Record<string, unknown>,
): Response | null {
  if (resource !== 'features') return null
  const key = String(body.key ?? '')
  if (!ALWAYS_ON.includes(key)) return null
  if (body.enabled !== false) return null

  const said = `"${key}" is part of what a node is and cannot be switched off.`
  return Response.json({ error: said, message: said }, { status: 409 })
}

/** What this call needs, and whether the caller has it. */
function guard(
  resource: string,
  action: 'read' | 'write' | 'delete',
  principal: Principal | null,
): { ok: true; permission: string } | { ok: false; response: Response } {
  // Append-only resources refuse every write here rather than relying on a
  // permission nobody happens to hold. A history somebody can edit is not one.
  const entry = RESOURCES[resource as keyof typeof RESOURCES] as
    | { readOnly?: boolean }
    | undefined
  if (entry?.readOnly && action !== 'read') {
    return { ok: false, response: forbidden(`${resource}:${action}`) }
  }

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

/**
 * Translates react-admin's `filter` object into SQL. Arrays become `IN` (which
 * is how getMany and getManyReference arrive), strings on text columns become
 * partial matches so the filter inputs behave like search, and everything else
 * is exact equality. Unknown keys are ignored rather than erroring, because
 * react-admin sends its own bookkeeping fields through the same object.
 */
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

/**
 * Turns a thrown error into an answer somebody can read.
 *
 * Without this an exception escapes into the runtime and comes back as a 500
 * whose body says `HTTPError` — which tells whoever is looking at the panel
 * nothing at all, including whether it was their fault. `message` as well as
 * `error` because react-admin reads the first and the rest of this API answers
 * with the second.
 */
async function answering<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run()
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'Something went wrong.'
    return Response.json(
      { error: detail, message: detail },
      { status: 500 },
    )
  }
}

export async function listResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  url: URL,
  principal: Principal | null,
) {
  return answering(async () => {
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
  })
}

export async function getResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  id: string,
  principal: Principal | null,
) {
  return answering(async () => {
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
  if (!allows(principal, allowed.permission, row)) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  return Response.json(row)
  })
}

export async function createResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  request: Request,
  principal: Principal | null,
) {
  return answering(async () => {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'write', principal)
  if (!allowed.ok) return allowed.response

  const body = (await request.json()) as Record<string, unknown>
  // Checked on the way in as well as the way out: a grant narrowed to one form
  // that still let you file rows against another would not be narrowed at all.
  if (!allows(principal, allowed.permission, body)) {
    return forbidden(allowed.permission)
  }
  const rows = (await db
    .insert(table as LooseTable)
    .values(stripReadOnly(table, body))
    .returning()) as Array<Record<string, unknown>>

  await noted(db, 'resource.created', resource, rows[0], principal)
  return Response.json(rows[0], { status: 201 })
  })
}

export async function updateResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  id: string,
  request: Request,
  principal: Principal | null,
) {
  return answering(async () => {
  const table = resolveResource(resource, features)
  if (!table) return notFound(resource)

  const allowed = guard(resource, 'write', principal)
  if (!allowed.ok) return allowed.response

  const columns = getTableColumns(table as LooseTable)
  const body = (await request.json()) as Record<string, unknown>

  // A toggle that accepts the click and changes nothing is worse than one that
  // is not offered at all. The screen does not show these; this is what makes
  // that true rather than decorative.
  const locked = lockedFeature(resource, body)
  if (locked) return locked
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
  await noted(db, 'resource.updated', resource, rows[0], principal)
  return Response.json(rows[0])
  })
}

export async function deleteResource(
  db: NodeDb,
  features: Array<string>,
  resource: string,
  id: string,
  principal: Principal | null,
) {
  return answering(async () => {
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
  await noted(db, 'resource.deleted', resource, rows[0], principal)
  return Response.json(rows[0])
  })
}

/**
 * Writes down a change somebody made through the panel.
 *
 * Here rather than in each route because every resource already passes through
 * these three functions — so instrumenting the layer instruments every screen,
 * including the ones added after this was written.
 *
 * Awaited, and that is not the obvious choice. Firing it and moving on reads
 * cheaper, and on a normal server it would be — but a Worker cancels whatever
 * is still pending when the response goes out, so a log written that way is
 * one that lands when the request happened to be slow and vanishes when it did
 * not. A recording that cannot be backfilled is not worth making conditional
 * on timing. `record` swallows its own failures, so this adds latency and no
 * failure mode.
 */
async function noted(
  db: NodeDb,
  name: string,
  resource: string,
  row: Record<string, unknown> | undefined,
  principal: Principal | null,
) {
  if (!row) return
  await record(db, {
    name,
    actor: principal,
    subjectType: resource,
    subjectId: row.id as string | number | undefined,
    // The row itself is deliberately not kept: it may hold somebody's enquiry,
    // and an event log is a poor place to make a second copy of that.
    detail: { resource },
  })
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
    if (key === 'id') continue
    const column = columns[key]
    if (!column) continue

    /*
      Timestamps are the server's.

      react-admin round-trips the whole record on update, so every date it was
      shown comes back as an ISO string — and Drizzle's timestamp columns want a
      Date, so one of those thrown at an update is an exception rather than a
      validation error. It surfaced as an unhandled 500 reading "HTTPError",
      which is the least useful sentence a panel can print.

      Dropped rather than parsed, because none of them is a field anybody is
      editing: `createdAt` is when the row appeared and `updatedAt` is when it
      last changed, and both are facts the database keeps rather than opinions
      a form holds. Anything else that is a timestamp is treated the same way
      for the same reason, so a table added later cannot reintroduce this.
    */
    if (column.dataType === 'date') continue

    values[key] = value
  }

  return values
}

/**
 * Whether a narrowed grant can reach anything in this resource at all.
 *
 * A grant narrowed to `userId` is a real grant, but the automations table has
 * no `userId` — so it selects nothing, and every call against it refuses. That
 * is correct, and it is also a tool an agent should never have been offered:
 * the point of deriving the list from the key is that everything on it works.
 *
 * The same reasoning `conditionWhere` uses, asked ahead of time. A group whose
 * every alternative names a column this table lacks is a group nothing can
 * satisfy, which makes the whole permission unreachable here.
 */
export function reachable(
  resource: string,
  features: Array<string>,
  principal: Principal,
  permission: string,
): boolean {
  const table = resolveResource(resource, features)
  if (!table) return false

  const columns = getTableColumns(table)
  return allowedWays(principal, permission).every((group) =>
    group.some((way) =>
      Object.keys(way).some((field) => Object.hasOwn(columns, field)),
    ),
  )
}
