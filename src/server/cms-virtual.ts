import { desc, eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import {
  automations,
  features,
  formSubmissions,
  forms,
  notifications,
  policies,
  roles,
  settings,
} from '#/db/schema'
import type { FormFieldDef } from '#/lib/form-shape'
import { FEATURE_CATALOG } from '#/lib/feature-catalog'
import type { NodeEnv } from './env'
import type { Principal } from './authz'
import { allows, can } from './authz'
import { listMembers, removeMember, setMemberRole } from './team'

/**
 * The database, as files the CMS already knows how to edit.
 *
 * The awkward part of putting dynamic data in a git-backed CMS is that the CMS
 * only believes in files. The tempting answer is to write the rows into the
 * repository and let it read them there — but this repository is public, it is
 * how the site is published, and a node's forms, users and access rules are not
 * things to publish as a side effect of making them editable.
 *
 * So the files are not written anywhere. They are answered.
 *
 * Sveltia asks for a listing (a git tree), and gets one with these entries
 * added. It then asks for their contents by blob id, and gets those too. Every
 * id here is `sha256("virtual:" + path)` — derived rather than stored, so the
 * same row always has the same id, no table is needed to remember which is
 * which, and an id from a stale tab still resolves to the row it named.
 *
 * Nothing leaves the node. A commit that touches one of these paths never
 * reaches GitHub; it becomes a database write, and the CMS is told the commit
 * happened. Which is the whole trick: to Sveltia this is one repository with a
 * few more files in it, and everything it does — the widgets, the validation,
 * the diffing, the editing UI — works on them unchanged.
 *
 * Everything below is one table of resources rather than one function per
 * screen, because the two dashboards have to stay level with each other. A
 * resource added here appears in the repo-defined CMS the same afternoon it
 * appears in the panel, and the permission that guards it is the same string in
 * both places.
 */

/** Where the answered files live. Deliberately dotted, so it cannot collide. */
export const VIRTUAL_ROOT = '.node'

/**
 * How many rows of one kind are offered at once.
 *
 * A tree is a single response and a CMS folder is a single list, so an inbox
 * with forty thousand enquiries in it would make both unusable long before it
 * made either wrong. The panel is the place to go through everything; this is
 * the place to work on what arrived recently.
 */
const PAGE = 200

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Row {
  /** the file name, without extension — stable and unique within the resource */
  slug: string
  /** the document the CMS edits */
  doc: Record<string, unknown>
  updatedAt: Date | null
  /** what a policy condition is evaluated against, if it is narrowed */
  record?: Record<string, unknown>
}

interface Resource {
  /** collection name in the CMS, and the folder under `.node/` */
  name: string
  label: string
  labelSingular?: string
  icon: string
  description: string
  /** permission to see it at all */
  read: string
  /** permission to save one; absent means the collection is read-only */
  write?: string
  /** permission to remove one; absent means entries cannot be deleted */
  destroy?: string
  /** only offered when this feature is on */
  feature?: string
  /** one entry rather than a list, drawn as a Sveltia `files` collection */
  singleton?: boolean
  /** whether the CMS may add entries */
  create?: boolean
  summary?: string
  list: (db: NodeDb, env: NodeEnv, principal: Principal) => Promise<Array<Row>>
  save?: (
    db: NodeDb,
    env: NodeEnv,
    principal: Principal,
    slug: string,
    doc: Record<string, unknown>,
  ) => Promise<string | null>
  remove?: (
    db: NodeDb,
    env: NodeEnv,
    principal: Principal,
    slug: string,
  ) => Promise<string | null>
  fields: Array<unknown>
}

/* --- widgets shared by more than one resource ---------------------------- */

const JSON_FIELD = (name: string, label: string, hint: string) => ({
  name,
  label,
  widget: 'text',
  required: false,
  hint,
})

/** A value the CMS may show but must not be the authority on. */
const READ_ONLY = (name: string, label: string) => ({
  name,
  label,
  widget: 'string',
  required: false,
  readonly: true,
})

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const stringify = (value: unknown) => JSON.stringify(value ?? null, null, 2)

/* --- the resources ------------------------------------------------------- */

export const RESOURCES: Array<Resource> = [
  {
    name: 'node_forms',
    label: 'Forms',
    labelSingular: 'Form',
    icon: 'assignment',
    description:
      'The forms this node serves. Saved here they take effect immediately — these are not files in the repository.',
    read: 'forms:read',
    write: 'forms:write',
    destroy: 'forms:delete',
    feature: 'forms',
    summary: '{{fields.name}} — {{fields.status}}',
    list: async (db, _env, principal) =>
      (await db.select().from(forms))
        .filter((row) =>
          allows(principal, 'forms:read', { id: row.id, formId: row.id }),
        )
        .map((row) => ({
          slug: row.slug,
          updatedAt: row.createdAt ?? null,
          record: { id: row.id, formId: row.id },
          doc: {
            name: row.name,
            slug: row.slug,
            status: row.status,
            target: row.target,
            required_at_signup: row.requiredAtSignup,
            success_message: row.successMessage ?? '',
            fields: row.fields ?? [],
          },
        })),
    save: async (db, _env, principal, slug, doc) => {
      const [row] = await db
        .select()
        .from(forms)
        .where(eq(forms.slug, slug))
        .limit(1)
      if (!row) return `There is no form called ${slug}.`
      if (!allows(principal, 'forms:write', { id: row.id, formId: row.id })) {
        return `Your account cannot change ${slug}.`
      }
      await db
        .update(forms)
        .set({
          name: String(doc.name ?? row.name),
          status: String(doc.status ?? row.status),
          target: String(doc.target ?? row.target),
          requiredAtSignup: Boolean(doc.required_at_signup ?? row.requiredAtSignup),
          successMessage:
            doc.success_message === undefined
              ? row.successMessage
              : String(doc.success_message),
          fields: Array.isArray(doc.fields)
            ? (doc.fields as Array<FormFieldDef>)
            : row.fields,
        })
        .where(eq(forms.id, row.id))
      return null
    },
    remove: async (db, _env, principal, slug) => {
      const [row] = await db
        .select()
        .from(forms)
        .where(eq(forms.slug, slug))
        .limit(1)
      if (!row) return null
      if (!allows(principal, 'forms:delete', { id: row.id, formId: row.id })) {
        return `Your account cannot delete ${slug}.`
      }
      await db.delete(forms).where(eq(forms.id, row.id))
      return null
    },
    fields: [
      { name: 'name', label: 'Name', widget: 'string' },
      { name: 'slug', label: 'Slug', widget: 'string', required: true },
      {
        name: 'status',
        label: 'Status',
        widget: 'select',
        options: ['draft', 'published', 'paused'],
      },
      {
        name: 'target',
        label: 'What it collects',
        widget: 'select',
        options: [
          { label: 'Anyone — a new row each time', value: 'public' },
          { label: 'The account — one row per person', value: 'profile' },
        ],
      },
      {
        name: 'required_at_signup',
        label: 'Required before anything else',
        widget: 'boolean',
        required: false,
      },
      {
        name: 'success_message',
        label: 'Message after sending',
        widget: 'string',
        required: false,
      },
      {
        name: 'fields',
        label: 'Fields',
        widget: 'list',
        fields: [
          { name: 'name', label: 'Key', widget: 'string' },
          { name: 'label', label: 'Label', widget: 'string' },
          {
            name: 'type',
            label: 'Type',
            widget: 'select',
            options: [
              'text',
              'email',
              'tel',
              'url',
              'textarea',
              'number',
              'select',
              'checkbox',
              'date',
            ],
          },
          { name: 'required', label: 'Required', widget: 'boolean', required: false },
          { name: 'placeholder', label: 'Placeholder', widget: 'string', required: false },
        ],
      },
    ],
  },

  {
    name: 'node_submissions',
    label: 'Submissions',
    labelSingular: 'Submission',
    icon: 'inbox',
    description:
      "What visitors have sent in. The answers are what arrived and are not editable; only how it has been handled is.",
    read: 'submissions:read',
    write: 'submissions:write',
    destroy: 'submissions:delete',
    feature: 'forms',
    create: false,
    summary: '{{fields.received}} — {{fields.status}}',
    list: async (db, _env, principal) =>
      (
        await db
          .select()
          .from(formSubmissions)
          .orderBy(desc(formSubmissions.id))
          .limit(PAGE)
      )
        .filter((row) =>
          allows(principal, 'submissions:read', {
            id: row.id,
            formId: row.formId,
            userId: row.userId,
          }),
        )
        .map((row) => ({
          slug: String(row.id),
          updatedAt: row.createdAt ?? null,
          record: { id: row.id, formId: row.formId, userId: row.userId },
          doc: {
            received: row.createdAt?.toISOString() ?? '',
            form_id: row.formId,
            status: row.status,
            answers: stringify(row.data),
          },
        })),
    save: async (db, _env, principal, slug, doc) => {
      const id = Number(slug)
      const [row] = await db
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.id, id))
        .limit(1)
      if (!row) return `There is no submission ${slug}.`
      if (
        !allows(principal, 'submissions:write', {
          id: row.id,
          formId: row.formId,
          userId: row.userId,
        })
      ) {
        return `Your account cannot change submission ${slug}.`
      }
      // Only the handling. What the visitor sent is a record of what they sent.
      await db
        .update(formSubmissions)
        .set({ status: String(doc.status ?? row.status) })
        .where(eq(formSubmissions.id, row.id))
      return null
    },
    remove: async (db, _env, principal, slug) => {
      const id = Number(slug)
      const [row] = await db
        .select()
        .from(formSubmissions)
        .where(eq(formSubmissions.id, id))
        .limit(1)
      if (!row) return null
      if (
        !allows(principal, 'submissions:delete', {
          id: row.id,
          formId: row.formId,
          userId: row.userId,
        })
      ) {
        return `Your account cannot delete submission ${slug}.`
      }
      await db.delete(formSubmissions).where(eq(formSubmissions.id, row.id))
      return null
    },
    fields: [
      READ_ONLY('received', 'Received'),
      READ_ONLY('form_id', 'Form'),
      {
        name: 'status',
        label: 'Handling',
        widget: 'select',
        options: ['new', 'read', 'handled', 'spam'],
      },
      JSON_FIELD('answers', 'What they sent', 'A record of what arrived. Changes here are not saved.'),
    ],
  },

  {
    name: 'node_automations',
    label: 'Notifications',
    labelSingular: 'Notification',
    icon: 'notifications_active',
    description: 'When something happens, tell these people, this way.',
    read: 'submissions:read',
    write: 'submissions:write',
    destroy: 'submissions:write',
    feature: 'forms',
    summary: '{{fields.name}} — {{fields.event}}',
    list: async (db) =>
      (await db.select().from(automations)).map((row) => ({
        slug: String(row.id),
        updatedAt: row.createdAt ?? null,
        doc: {
          name: row.name,
          event: row.event,
          enabled: row.enabled,
          when: stringify(row.when),
          audience: stringify(row.audience),
          channels: row.channels ?? ['email'],
        },
      })),
    save: async (db, _env, _principal, slug, doc) => {
      const id = Number(slug)
      const [row] = await db
        .select()
        .from(automations)
        .where(eq(automations.id, id))
        .limit(1)
      if (!row) return `There is no notification ${slug}.`
      await db
        .update(automations)
        .set({
          name: String(doc.name ?? row.name),
          event: String(doc.event ?? row.event),
          enabled: Boolean(doc.enabled ?? row.enabled),
          when: parseJson(doc.when, row.when) as any,
          audience: parseJson(doc.audience, row.audience) as any,
          channels: Array.isArray(doc.channels)
            ? (doc.channels as Array<string>)
            : row.channels,
        })
        .where(eq(automations.id, row.id))
      return null
    },
    remove: async (db, _env, _principal, slug) => {
      await db.delete(automations).where(eq(automations.id, Number(slug)))
      return null
    },
    fields: [
      { name: 'name', label: 'Name', widget: 'string' },
      { name: 'event', label: 'When', widget: 'string' },
      { name: 'enabled', label: 'On', widget: 'boolean', required: false },
      JSON_FIELD('when', 'Only these records', 'A condition, as JSON. Empty object for all of them.'),
      JSON_FIELD('audience', 'Who hears', 'People, roles, policies and bare addresses, as JSON.'),
      { name: 'channels', label: 'How', widget: 'list', required: false },
    ],
  },

  {
    name: 'node_sent',
    label: 'Sent',
    labelSingular: 'Message',
    icon: 'send',
    description: 'Every attempt to tell somebody something, and how it went.',
    read: 'submissions:read',
    feature: 'forms',
    create: false,
    summary: '{{fields.target}} — {{fields.status}}',
    list: async (db) =>
      (
        await db
          .select()
          .from(notifications)
          .orderBy(desc(notifications.id))
          .limit(PAGE)
      ).map((row) => ({
        slug: String(row.id),
        updatedAt: row.createdAt ?? null,
        doc: {
          sent: row.createdAt?.toISOString() ?? '',
          channel: row.channel,
          target: row.target,
          status: row.status,
          detail: row.detail ?? '',
        },
      })),
    fields: [
      READ_ONLY('sent', 'Sent'),
      READ_ONLY('channel', 'Channel'),
      READ_ONLY('target', 'To'),
      READ_ONLY('status', 'Status'),
      READ_ONLY('detail', 'Detail'),
    ],
  },

  {
    name: 'node_users',
    label: 'Users',
    labelSingular: 'User',
    icon: 'group',
    description:
      'Who can reach this node. Changing a role here changes it everywhere, including any keys that account holds.',
    read: 'team:read',
    write: 'team:manage',
    destroy: 'team:manage',
    feature: 'user-management',
    create: false,
    summary: '{{fields.email}} — {{fields.role}}',
    list: async (_db, env) =>
      (await listMembers(env)).map((member) => ({
        slug: member.id,
        updatedAt: member.createdAt ? new Date(member.createdAt) : null,
        doc: {
          email: member.email,
          name: member.name ?? '',
          role: member.roleKey ?? '',
          root_admin: member.isOwner,
        },
      })),
    save: async (_db, env, _principal, slug, doc) => {
      const members = await listMembers(env)
      const member = members.find((one) => one.id === slug)
      if (!member) return 'There is no such account.'
      // The root admin's role is not stored and must not become storable —
      // it is what having been seeded by master means.
      if (member.isOwner) return 'The root admin’s role cannot be changed.'
      await setMemberRole(env, slug, String(doc.role ?? '') || null)
      return null
    },
    remove: async (_db, env, _principal, slug) => {
      const members = await listMembers(env)
      const member = members.find((one) => one.id === slug)
      if (member?.isOwner) return 'The root admin cannot be removed.'
      await removeMember(env, slug)
      return null
    },
    fields: [
      READ_ONLY('email', 'Email'),
      READ_ONLY('name', 'Name'),
      { name: 'role', label: 'Role', widget: 'string', required: false },
      { name: 'root_admin', label: 'Root admin', widget: 'boolean', required: false, readonly: true },
    ],
  },

  {
    name: 'node_roles',
    label: 'Roles',
    labelSingular: 'Role',
    icon: 'shield',
    description: 'What a kind of access is, and which policies it carries.',
    read: 'team:read',
    write: 'team:manage',
    destroy: 'team:manage',
    feature: 'user-management',
    summary: '{{fields.name}}',
    list: async (db) =>
      (await db.select().from(roles)).map((row) => ({
        slug: row.key,
        updatedAt: row.createdAt ?? null,
        doc: {
          key: row.key,
          name: row.name,
          description: row.description ?? '',
          permissions: row.permissions ?? [],
          policies: row.policies ?? [],
          conditions: stringify(row.conditions),
          builtin: row.builtin,
        },
      })),
    save: async (db, _env, _principal, slug, doc) => {
      const [row] = await db.select().from(roles).where(eq(roles.key, slug)).limit(1)
      if (!row) return `There is no role called ${slug}.`
      await db
        .update(roles)
        .set({
          name: String(doc.name ?? row.name),
          description:
            doc.description === undefined ? row.description : String(doc.description),
          permissions: Array.isArray(doc.permissions)
            ? (doc.permissions as Array<string>)
            : row.permissions,
          policies: Array.isArray(doc.policies)
            ? (doc.policies as Array<string>)
            : row.policies,
          conditions: parseJson(doc.conditions, row.conditions) as any,
        })
        .where(eq(roles.id, row.id))
      return null
    },
    remove: async (db, _env, _principal, slug) => {
      const [row] = await db.select().from(roles).where(eq(roles.key, slug)).limit(1)
      if (!row) return null
      if (row.builtin) return 'That role comes with the node and cannot be removed.'
      await db.delete(roles).where(eq(roles.id, row.id))
      return null
    },
    fields: [
      READ_ONLY('key', 'Key'),
      { name: 'name', label: 'Name', widget: 'string' },
      { name: 'description', label: 'Description', widget: 'text', required: false },
      { name: 'permissions', label: 'Permissions', widget: 'list', required: false },
      { name: 'policies', label: 'Policies', widget: 'list', required: false },
      JSON_FIELD('conditions', 'Its own narrowing', 'permission → field → rule, as JSON.'),
      { name: 'builtin', label: 'Built in', widget: 'boolean', required: false, readonly: true },
    ],
  },

  {
    name: 'node_policies',
    label: 'Policies',
    labelSingular: 'Policy',
    icon: 'balance',
    description:
      'One rule about records, attachable to any number of roles. A refusal beats every grant beside it.',
    read: 'team:read',
    write: 'team:manage',
    destroy: 'team:manage',
    feature: 'user-management',
    summary: '{{fields.name}} — {{fields.effect}}',
    list: async (db) =>
      (await db.select().from(policies)).map((row) => ({
        slug: row.key,
        updatedAt: row.createdAt ?? null,
        doc: {
          key: row.key,
          name: row.name,
          description: row.description ?? '',
          effect: row.effect,
          permissions: row.permissions ?? [],
          condition: stringify(row.condition),
        },
      })),
    save: async (db, _env, _principal, slug, doc) => {
      const [row] = await db
        .select()
        .from(policies)
        .where(eq(policies.key, slug))
        .limit(1)
      if (!row) return `There is no policy called ${slug}.`
      await db
        .update(policies)
        .set({
          name: String(doc.name ?? row.name),
          description:
            doc.description === undefined ? row.description : String(doc.description),
          effect: doc.effect === 'deny' ? 'deny' : 'allow',
          permissions: Array.isArray(doc.permissions)
            ? (doc.permissions as Array<string>)
            : row.permissions,
          condition: parseJson(doc.condition, row.condition) as any,
        })
        .where(eq(policies.id, row.id))
      return null
    },
    remove: async (db, _env, _principal, slug) => {
      await db.delete(policies).where(eq(policies.key, slug))
      return null
    },
    fields: [
      READ_ONLY('key', 'Key'),
      { name: 'name', label: 'Name', widget: 'string' },
      { name: 'description', label: 'Description', widget: 'text', required: false },
      {
        name: 'effect',
        label: 'Effect',
        widget: 'select',
        options: [
          { label: 'Allow — widens what a role reaches', value: 'allow' },
          { label: 'Refuse — narrows it, and wins any disagreement', value: 'deny' },
        ],
      },
      {
        name: 'permissions',
        label: 'Permissions',
        widget: 'list',
        required: false,
        hint: 'A single entry of * covers everything the node offers.',
      },
      JSON_FIELD('condition', 'Which records', 'field → rule, as JSON. Empty object for all of them.'),
    ],
  },

  {
    name: 'node_features',
    label: 'Features',
    labelSingular: 'Feature',
    icon: 'tune',
    description:
      'What this node does at all. Switching one off takes its permissions with it.',
    read: 'settings:read',
    write: 'features:manage',
    create: false,
    summary: '{{fields.label}} — {{fields.enabled}}',
    list: async (db) => {
      const rows = await db.select().from(features)
      const enabled = new Map(rows.map((row) => [row.key, row]))
      return FEATURE_CATALOG.map((entry) => ({
        slug: entry.key,
        updatedAt: enabled.get(entry.key)?.updatedAt ?? null,
        doc: {
          key: entry.key,
          label: entry.name,
          description: entry.description,
          enabled: enabled.get(entry.key)?.enabled ?? false,
        },
      }))
    },
    save: async (db, _env, _principal, slug, doc) => {
      const known = FEATURE_CATALOG.some((entry) => entry.key === slug)
      if (!known) return `There is no feature called ${slug}.`
      const [row] = await db
        .select()
        .from(features)
        .where(eq(features.key, slug))
        .limit(1)
      const on = Boolean(doc.enabled)
      if (row) {
        await db
          .update(features)
          .set({ enabled: on, updatedAt: new Date() })
          .where(eq(features.id, row.id))
      } else {
        await db.insert(features).values({ key: slug, enabled: on })
      }
      return null
    },
    fields: [
      READ_ONLY('key', 'Key'),
      READ_ONLY('label', 'Name'),
      READ_ONLY('description', 'What it does'),
      { name: 'enabled', label: 'On', widget: 'boolean', required: false },
    ],
  },

  {
    name: 'node_settings',
    label: 'Node settings',
    icon: 'settings_applications',
    description: "This node's own address, separate from the site's content.",
    read: 'settings:read',
    write: 'settings:write',
    singleton: true,
    create: false,
    list: async (db) => {
      const [row] = await db.select().from(settings).limit(1)
      return [
        {
          slug: 'node',
          updatedAt: row?.updatedAt ?? null,
          doc: {
            custom_domain: row?.customDomain ?? '',
            dns_zone: row?.dnsZone ?? '',
            frontend_verified: row?.frontendVerified ?? false,
            api_verified: row?.apiVerified ?? false,
          },
        },
      ]
    },
    save: async (db, _env, _principal, _slug, doc) => {
      const [row] = await db.select().from(settings).limit(1)
      const values = {
        customDomain: String(doc.custom_domain ?? '') || null,
        updatedAt: new Date(),
      }
      if (row) {
        await db.update(settings).set(values).where(eq(settings.id, row.id))
      } else {
        await db.insert(settings).values(values)
      }
      return null
    },
    fields: [
      { name: 'custom_domain', label: 'Custom domain', widget: 'string', required: false },
      READ_ONLY('dns_zone', 'DNS zone'),
      { name: 'frontend_verified', label: 'Site DNS verified', widget: 'boolean', required: false, readonly: true },
      { name: 'api_verified', label: 'API DNS verified', widget: 'boolean', required: false, readonly: true },
    ],
  },
]

/* --- the machinery ------------------------------------------------------- */

export interface VirtualEntry {
  path: string
  text: string
  oid: string
  updatedAt: Date | null
}

async function oidFor(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`virtual:${path}`),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    // A git object id is forty hex characters, and Sveltia passes it straight
    // through to a query that expects one.
    .slice(0, 40)
}

/** Resources this account may see at all, on this node. */
function visibleResources(
  principal: Principal,
  enabledFeatures: Array<string>,
): Array<Resource> {
  return RESOURCES.filter((resource) => {
    if (resource.feature && !enabledFeatures.includes(resource.feature)) {
      return false
    }
    return can(principal, resource.read)
  })
}

export function pathFor(resource: Resource, slug: string): string {
  return `${VIRTUAL_ROOT}/${resource.name}/${slug}.json`
}

/**
 * Every answered file this account may see.
 *
 * Filtered here rather than after the fact, because a listing is how the CMS
 * decides what exists: a row left out of this does not appear, cannot be
 * opened, and has no id anybody could ask for.
 */
export async function virtualEntries(
  db: NodeDb,
  env: NodeEnv,
  principal: Principal,
  enabledFeatures: Array<string>,
): Promise<Array<VirtualEntry>> {
  const entries: Array<VirtualEntry> = []

  for (const resource of visibleResources(principal, enabledFeatures)) {
    let rows: Array<Row>
    try {
      rows = await resource.list(db, env, principal)
    } catch {
      // One resource that cannot be read must not empty the whole dashboard.
      continue
    }

    for (const row of rows) {
      const path = pathFor(resource, row.slug)
      entries.push({
        path,
        text: JSON.stringify(row.doc, null, 2),
        oid: await oidFor(path),
        updatedAt: row.updatedAt,
      })
    }
  }

  return entries
}

export function isVirtual(path: string): boolean {
  return path === VIRTUAL_ROOT || path.startsWith(`${VIRTUAL_ROOT}/`)
}

/** Which resource and which row a virtual path names. */
function locate(
  path: string,
): { resource: Resource; slug: string } | null {
  const match = new RegExp(`^${VIRTUAL_ROOT}/([^/]+)/(.+)\\.json$`).exec(path)
  if (!match) return null
  const resource = RESOURCES.find((entry) => entry.name === match[1])
  return resource ? { resource, slug: match[2]! } : null
}

/**
 * Applies a write to the database instead of the repository.
 *
 * Returns a message when it may not happen, so the caller can refuse the whole
 * commit — a mutation that half-applied would leave the CMS showing one thing
 * and the node serving another.
 */
export async function applyVirtualWrite(
  db: NodeDb,
  env: NodeEnv,
  principal: Principal,
  enabledFeatures: Array<string>,
  path: string,
  document: unknown,
): Promise<string | null> {
  const found = locate(path)
  if (!found) return `There is nothing at ${path} to change.`

  const { resource, slug } = found
  if (resource.feature && !enabledFeatures.includes(resource.feature)) {
    return `${resource.label} is not switched on.`
  }
  if (!resource.write || !resource.save) {
    return `${resource.label} cannot be changed here.`
  }
  if (!can(principal, resource.write)) {
    return `Your account cannot change ${resource.label.toLowerCase()}.`
  }

  return resource.save(db, env, principal, slug, (document ?? {}) as Record<string, unknown>)
}

export async function applyVirtualDelete(
  db: NodeDb,
  env: NodeEnv,
  principal: Principal,
  enabledFeatures: Array<string>,
  path: string,
): Promise<string | null> {
  const found = locate(path)
  if (!found) return `There is nothing at ${path} to delete.`

  const { resource, slug } = found
  if (resource.feature && !enabledFeatures.includes(resource.feature)) {
    return `${resource.label} is not switched on.`
  }
  if (!resource.destroy || !resource.remove) {
    return `${resource.label} cannot be deleted here.`
  }
  if (!can(principal, resource.destroy)) {
    return `Your account cannot delete ${resource.label.toLowerCase()}.`
  }

  return resource.remove(db, env, principal, slug)
}

/**
 * The collections these files belong to, in Sveltia's own vocabulary.
 *
 * Appended to the repo's own configuration, so the dashboard has one sidebar
 * with the site's collections and the node's in it — and the node's are
 * ordinary collections pointed at folders that do not exist on disk. Nothing in
 * Sveltia is aware of the difference.
 */
export function virtualCollections(
  principal: Principal,
  enabledFeatures: Array<string>,
): Array<unknown> {
  return visibleResources(principal, enabledFeatures).map((resource) => {
    const writable = Boolean(resource.write && can(principal, resource.write))

    if (resource.singleton) {
      return {
        name: resource.name,
        label: resource.label,
        icon: resource.icon,
        files: [
          {
            name: 'node',
            label: resource.label,
            file: pathFor(resource, 'node'),
            format: 'json',
            description: resource.description,
            fields: resource.fields,
          },
        ],
      }
    }

    return {
      name: resource.name,
      label: resource.label,
      label_singular: resource.labelSingular ?? resource.label,
      icon: resource.icon,
      folder: `${VIRTUAL_ROOT}/${resource.name}`,
      extension: 'json',
      format: 'json',
      // Creating one would have to invent an identifier before the node has a
      // row for it. Adding is the panel's job; editing is this one's.
      create: false,
      delete: Boolean(
        resource.destroy && resource.remove && can(principal, resource.destroy),
      ),
      identifier_field: 'slug',
      summary: resource.summary,
      description: resource.description,
      // A reader who cannot write gets an editor that says so, rather than one
      // that discovers it on save.
      fields: writable
        ? resource.fields
        : resource.fields.map((field) => ({
            ...(field as Record<string, unknown>),
            readonly: true,
          })),
    }
  })
}
