import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

import type { FormFieldDef } from '#/lib/form-shape'

export type { FieldFill, FormChoice, FormFieldDef } from '#/lib/form-shape'
export { choicesOf } from '#/lib/form-shape'

/**
 * Which features this node runs.
 *
 * The node owns this outright — master does not grant, gate or even know about
 * it. A toggle here takes effect on the next request, with no redeploy and no
 * round trip to the control plane, which is the whole point of the node
 * deciding for itself.
 *
 * Rows are keyed by `key` against `FEATURE_CATALOG`; a catalog entry with no row
 * yet reads as disabled, which is how a newly shipped feature behaves on an
 * existing node.
 */
export const features = sqliteTable('features', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  key: text().notNull().unique(),
  enabled: integer({ mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * Node-wide settings. One row.
 *
 * The custom domain lives here rather than on the features that use it, because
 * a node's address is a property of the node — the API keeps its domain even if
 * the frontend feature is switched off.
 *
 * `*Verified` records whether DNS was seen pointing at the right target, so the
 * UI can tell "not set up" from "set up and waiting for propagation" without
 * re-querying on every render.
 */
export const settings = sqliteTable('settings', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /**
   * One registrable domain for the whole node.
   *
   * Every hostname the node needs is derived from it — the site on the apex,
   * the API on `api.`, and email later — so the operator sets this once rather
   * than keeping several fields in step. See `domain-plan.ts`.
   */
  customDomain: text('custom_domain'),
  /** the DNS zone the domain sits in, learned from its nameservers */
  dnsZone: text('dns_zone'),
  /** per-use verification, because the records are added and spread separately */
  frontendVerified: integer('frontend_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  apiVerified: integer('api_verified', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * A Cloudflare account the operator granted DNS access to.
 *
 * Optional convenience: when their domain is on Cloudflare, the node can write
 * the DNS records itself instead of the operator copying five of them by hand.
 * At most one row, and the tokens never leave this Worker.
 */
export const cloudflareConnections = sqliteTable('cloudflare_connections', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  /** epoch seconds; null when Cloudflare did not say */
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * The GitHub account this node is connected to, and the site it publishes.
 *
 * At most one row: a node publishes one site. The access token is stored so the
 * node can push config changes and manage Pages later, and is never returned by
 * any API — see `redactConnection`.
 */
export const githubConnections = sqliteTable('github_connections', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  login: text().notNull(),
  accessToken: text('access_token').notNull(),
  repoOwner: text('repo_owner'),
  repoName: text('repo_name'),
  pagesUrl: text('pages_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * A key that acts as one of this node's users.
 *
 * Not a separate kind of principal with its own scopes — a key *is* the user it
 * belongs to. A website is given an account with the `frontend` role and a key
 * to prove it, which means one place decides what anything may do: change the
 * role and every key held by that account changes with it.
 *
 * Only a hash is kept. The secret is shown once, at the moment it is minted,
 * because a key that can be read back out of the panel is a key that leaks with
 * the panel.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    /** the better-auth user this key acts as */
    userId: text('user_id').notNull(),
    name: text().notNull(),
    /** the readable half, so a key can be recognised without revealing it */
    prefix: text().notNull(),
    hash: text().notNull(),
    /**
     * Origins this key works from. A key shipped in a page's JavaScript is
     * readable by anyone who views source, so the useful question is not
     * whether it leaks but what a copy of it is worth somewhere else. Bound to
     * an origin, a stolen key is worth nothing outside the site it came from.
     *
     * Empty means anywhere, which is right for a key on a server and wrong for
     * one in a browser — so the panel says so when minting.
     */
    allowedOrigins: text('allowed_origins', { mode: 'json' })
      .$type<Array<string>>()
      .notNull()
      .default([]),
    /** most requests per minute; 0 leaves it uncapped */
    ratePerMinute: integer('rate_per_minute').notNull().default(0),
    /**
     * What the person who minted it chose to let it do — the second gate.
     *
     * The first gate is the account's own role and policies, and a key can
     * never reach past it. This is the holder narrowing their own reach before
     * handing it to something else: an agent given a key for one job should be
     * able to do that job and discover nothing else.
     *
     * `null` means unrestricted, which is not the same as `[]`. An empty list
     * is a key that may do nothing, and both are things somebody might mean.
     */
    scopePermissions: text('scope_permissions', { mode: 'json' })
      .$type<Array<string> | null>()
      .default(null),
    /** the same shape a role uses: permission -> field -> rule */
    scopeConditions: text('scope_conditions', { mode: 'json' })
      .$type<Record<string, RoleCondition>>()
      .notNull()
      .default({}),
    /** policies applied to this key alone, on top of the account's */
    scopePolicies: text('scope_policies', { mode: 'json' })
      .$type<Array<string>>()
      .notNull()
      .default([]),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('api_keys_prefix').on(table.prefix)],
)

/**
 * An automation: when this happens, tell these people, this way.
 *
 * Three columns for three questions that change independently — `event` and
 * `when` say which records set it off, `audience` says who hears, `channels`
 * says how. Splitting them is what lets one form's enquiries reach the trade
 * desk by email today and by SMS later without touching the rows.
 *
 * `when` reuses the shape role conditions use, because it is the same question
 * asked twice: which records does this apply to. A submission's own answers are
 * addressed as `data.<field>`.
 */
export const automations = sqliteTable('automations', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  /** a key from the trigger catalog, e.g. `submission.created` */
  event: text().notNull(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  /** field -> rule, e.g. { "formId": { "in": [3] } } */
  when: text({ mode: 'json' }).$type<Record<string, AutomationRule>>().notNull().default({}),
  /** people, roles, policies and bare addresses */
  audience: text({ mode: 'json' }).$type<Record<string, Array<string>>>().notNull().default({}),
  /** channel keys; unavailable ones are stored and skipped until they exist */
  channels: text({ mode: 'json' }).$type<Array<string>>().notNull().default(['email']),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/** How an automation narrows the records it fires on. */
export type AutomationRule = {
  in?: Array<string | number>
  eq?: string | number
  contains?: string
  filled?: boolean
}

/**
 * One attempt to tell one person, on one channel.
 *
 * Written whether or not it worked, because "did they get told" is the question
 * anyone asks after the fact and the alternative is guessing from mail logs.
 * It is also where the in-app channel comes from when it lands: an unread
 * notification is a row here, so that channel is a read rather than new
 * plumbing.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    automationId: integer('automation_id'),
    /** which record set it off, so the panel can link back to it */
    subjectType: text('subject_type').notNull().default('submission'),
    subjectId: integer('subject_id'),
    channel: text().notNull(),
    /** the address, phone or user id it was aimed at */
    target: text().notNull(),
    /** set when the target is someone with an account here */
    userId: text('user_id'),
    /** queued -> sent | failed | skipped */
    status: text().notNull().default('queued'),
    detail: text(),
    readAt: integer('read_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('notifications_user_read').on(table.userId, table.readAt)],
)

/**
 * Something that happened, kept because it cannot be worked out later.
 *
 * The reason this exists before anything reads it: recording cannot be
 * backfilled. A node live for a month before somebody writes this table has
 * lost a month, and no dashboard built afterwards can get it back. So it is
 * written from the day the node runs and read whenever the reading is built.
 *
 * Decisions, not traffic. A row here is somebody doing something — an enquiry
 * arriving, a form being published, an order paid, a slot booked — and never a
 * request being served. The distinction is what keeps a busy node from filling
 * its database with its own logs.
 *
 * `vendorId` is null until vendors exist. It is present now because adding a
 * column to a table with history in it means deciding what the old rows meant,
 * and there is nothing to decide while the table is empty.
 */
export const events = sqliteTable(
  'events',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    /** a key from the event catalog, e.g. `submission.created` */
    name: text().notNull(),
    /** who did it; null for anything the node did on its own */
    actorUserId: text('actor_user_id'),
    /** whether that actor was a key rather than a person at a browser */
    viaKey: integer('via_key', { mode: 'boolean' }).notNull().default(false),
    /** whose business it concerns, once there is more than one */
    vendorId: integer('vendor_id'),
    /** what it happened to: a resource name and its id */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    /** anything worth keeping that is not a column */
    detail: text({ mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    // The two questions a dashboard asks: what happened lately, and what
    // happened to this vendor lately.
    index('events_created').on(table.createdAt),
    index('events_vendor_created').on(table.vendorId, table.createdAt),
  ],
)

/**
 * A role, as the business defines it.
 *
 * Deliberately a row rather than a type in code. Whoever runs the business
 * decides what its team looks like — a two-person shop with an owner and a
 * bookkeeper, an agency with designers who may touch the site but not the
 * submissions, a shift roster where each person only sees their own branch's
 * enquiries. None of those shapes can be known here, so the catalog in code
 * says what *can* be granted and rows like this say what *is*.
 *
 * `permissions` is the RBAC half: which keys from the catalog this role holds.
 * `conditions` is the PBAC half: for a permission the role holds, an optional
 * rule narrowing which records it reaches — `submissions:read` over every form
 * is a different job from `submissions:read` over one.
 */
export const roles = sqliteTable('roles', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** stable id, stored on the user; renaming a role must not orphan anyone */
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  permissions: text({ mode: 'json' }).$type<Array<string>>().notNull().default([]),
  /** permission key -> field -> rule, e.g. { "submissions:read": { "formId": { "in": [3] } } } */
  conditions: text({ mode: 'json' })
    .$type<Record<string, RoleCondition>>()
    .notNull()
    .default({}),
  /**
   * Policies this role carries, by key.
   *
   * A role's own `permissions` and `conditions` above are still its own — they
   * are the quick way to say something once, for a role nobody else shares.
   * Policies are for the rest: the same narrowing wanted by four roles, written
   * once and attached four times.
   */
  policies: text({ mode: 'json' }).$type<Array<string>>().notNull().default([]),
  /** seeded and not deletable — the node must always have a way back in */
  builtin: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/** How a permission is narrowed. Each entry is a field and what it must match. */
export type RoleCondition = Record<
  string,
  { in?: Array<string | number>; eq?: string | number; self?: boolean }
>

/**
 * A named rule about records, attachable to any number of roles.
 *
 * Roles answer "what kind of access is this". Conditions answer "over which
 * records". Until now the second lived inside the first, which meant a business
 * with four desks and one rule about whose enquiries each may read had to write
 * that rule four times and remember all four when it changed.
 *
 * A policy lifts it out: policies → roles → users. The role stays the thing a
 * person is given, and the policy becomes the thing a rule is. It is the shape
 * IAM settled on for the same reason, including the part that matters most —
 * `deny` beats `allow`, always. A rule that says "not the HR enquiries" has to
 * survive somebody later attaching a generous role, or it is not a rule.
 */
export const policies = sqliteTable('policies', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** stable id, referenced by roles; renaming must not detach anything */
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  /** `allow` widens what a role reaches; `deny` narrows it and wins ties */
  effect: text().notNull().default('allow'),
  /** the permissions this policy speaks about; `*` means all of them */
  permissions: text({ mode: 'json' }).$type<Array<string>>().notNull().default([]),
  /**
   * Which records it speaks about. Empty means all of them — an allow with no
   * condition is a plain grant, and a deny with no condition is a flat refusal.
   */
  condition: text({ mode: 'json' })
    .$type<RoleCondition>()
    .notNull()
    .default({}),
  builtin: integer({ mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * An invitation to join this node's team.
 *
 * A link rather than an email, because a node has no mail sender of its own
 * yet. The token is the credential: it is long, single-use, and expires, so a
 * link that leaks is bounded rather than permanent.
 */
export const invitations = sqliteTable('invitations', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  email: text().notNull(),
  roleKey: text('role_key').notNull(),
  token: text().notNull().unique(),
  invitedBy: text('invited_by'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * The push webhook this node registered on the site's repository.
 *
 * Its own table rather than a column on `github_connections`, because node
 * migrations only ever create tables — an ALTER would fail the second time a
 * node is provisioned, which happens on every deploy.
 *
 * The secret is ours: we generate it, hand it to GitHub once, and check every
 * delivery against it. It never leaves this row.
 */
export const repoHooks = sqliteTable('repo_hooks', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  /** GitHub's id for the hook, so it is updated rather than duplicated */
  hookId: integer('hook_id').notNull(),
  url: text().notNull(),
  secret: text().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * One field in a form's definition. Stored as JSON on the form row.
 *
 * This is deliberately the same shape the site's `admin-cms.json` declares, so
 * a field can move between the two without being translated. The node ignores
 * `width` and `showWhen` — they say how the site draws the field, not what it
 * accepts — but it stores them, because the alternative is dropping them every
 * time a form is saved from the panel.
 */
/**
 * A form the node's operator builds in the admin panel. `slug` is what the
 * public API addresses it by, and what a static frontend hard-codes.
 *
 * The field list lives in a JSON column rather than its own table: a form's
 * fields are only ever read and written as a whole, and keeping them together
 * means editing a form is one row write.
 */
export const forms = sqliteTable('forms', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  slug: text().notNull().unique(),
  /** draft forms are invisible to the public API; paused ones answer 410 */
  status: text().notNull().default('draft'),
  fields: text({ mode: 'json' })
    .$type<Array<FormFieldDef>>()
    .notNull()
    .default([]),
  successMessage: text('success_message'),
  /**
   * What the form collects.
   *
   * `public` is the ordinary kind: anyone may send it and every send is a new
   * row. `profile` binds it to whoever is signed in — one row per person,
   * edited rather than resent, and readable back to them. It is the same form
   * builder either way; only what a submission *is* changes.
   */
  target: text().notNull().default('public'),
  /** a profile form the site asks for before letting someone get on with it */
  requiredAtSignup: integer('required_at_signup', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

/**
 * One submission against a form. `data` holds the submitted values keyed by
 * field name — deliberately schemaless, because a form's shape can change after
 * submissions already exist and old rows must stay readable.
 */
export const formSubmissions = sqliteTable(
  'form_submissions',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    formId: integer('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /**
     * Whose it is, when it belongs to somebody.
     *
     * Null for the anonymous kind, which is most of them. Set for a profile,
     * and that is what makes `self` scoping work: a role narrowed to
     * `{ userId: { self: true } }` reaches its own row and no one else's, in
     * the same WHERE clause every other narrowing uses.
     */
    userId: text('user_id'),
    data: text({ mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text().notNull().default('new'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('submissions_form_created').on(table.formId, table.createdAt)],
)
