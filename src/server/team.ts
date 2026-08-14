import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import type { RoleCondition } from '#/db/schema'
import {
  invitations,
  policies as policiesTable,
  roles as rolesTable,
} from '#/db/schema'
import { permissionKeys } from '#/lib/permission-catalog'
import type { NodeEnv } from './env'
import { getAuth } from './auth'
import { getEnabledFeatures } from './features'
import { OWNER_ROLE } from './authz'

/**
 * The people who can reach this node, and the roles they hold.
 *
 * Better Auth owns the user table and migrates it itself, so this reads it
 * through Better Auth's own adapter rather than declaring it in Drizzle. Two
 * migration systems writing the same table is a fight neither wins.
 */

export interface Member {
  id: string
  email: string
  name: string | null
  roleKey: string | null
  isOwner: boolean
  createdAt: string | null
}

interface RawUser {
  id: string
  email: string
  name?: string | null
  role?: string | null
  masterUserId?: string | null
  createdAt?: Date | string | null
}

async function adapter(env: NodeEnv) {
  return (await getAuth(env).$context).adapter
}

export async function listMembers(env: NodeEnv): Promise<Array<Member>> {
  const rows = (await (
    await adapter(env)
  ).findMany({ model: 'user', limit: 200 })) as Array<RawUser>

  return rows.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    // The owner's role is not stored; it is what having been seeded by master
    // means. Storing it would make it editable, and it must not be.
    roleKey: user.masterUserId ? OWNER_ROLE : (user.role ?? null),
    isOwner: Boolean(user.masterUserId),
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
  }))
}

export async function findMember(
  env: NodeEnv,
  id: string,
): Promise<Member | null> {
  const members = await listMembers(env)
  return members.find((member) => member.id === id) ?? null
}

export async function setMemberRole(
  env: NodeEnv,
  id: string,
  roleKey: string | null,
): Promise<void> {
  await (
    await adapter(env)
  ).update({
    model: 'user',
    where: [{ field: 'id', value: id }],
    update: { role: roleKey },
  })
}

export async function removeMember(env: NodeEnv, id: string): Promise<void> {
  const db = await adapter(env)
  // Sessions and credentials go too, or a removed member keeps a live cookie.
  for (const model of ['session', 'account']) {
    await db.deleteMany({ model, where: [{ field: 'userId', value: id }] })
  }
  await db.delete({ model: 'user', where: [{ field: 'id', value: id }] })
}

/**
 * The roles a node starts with.
 *
 * Named after jobs the business actually has rather than after the permissions
 * behind them, because the person choosing is hiring, not configuring: someone
 * answers the enquiries, someone else changes how the site looks.
 *
 * They are ordinary rows, not fixed types. Seeded so a node is usable the
 * moment it exists, and editable afterwards — a business whose designer must
 * not touch the form declaration only has to untick it.
 *
 * `rootAdmin` is the node-side half of the master account. The person who
 * created the project on master arrives here as its rootAdmin, which is why it
 * cannot be deleted: it is the way back in.
 */
const BUILTIN_ROLES = [
  {
    key: 'rootAdmin',
    name: 'Root admin',
    description:
      'Everything this node can do, including who else gets in. The counterpart of the account that created the project.',
    builtin: true,
    /** every permission the node currently offers */
    all: true,
  },
  {
    key: 'designer',
    name: 'Designer',
    description:
      'The site: its pages, symbols, content and the visual builder. Not the enquiries, and not who has access.',
    builtin: false,
    permissions: [
      'content:read',
      'content:write',
      // Granted to begin with and meant to be revokable — it decides what the
      // node serves rather than how a page looks.
      'config:write',
    ],
  },
  {
    key: 'operator',
    name: 'Operator',
    description:
      'The enquiries: reads what visitors send in and marks them handled. Cannot change the site.',
    builtin: false,
    permissions: ['forms:read', 'submissions:read', 'submissions:write'],
    // Deliberately without `submissions:delete`. Handling the enquiries is the
    // job; destroying them is a decision for whoever owns the node.
  },
  {
    key: 'frontend',
    name: 'Frontend',
    description:
      'A website, not a person. Reads the form definitions it has to draw and files what visitors send. Holds an API key rather than a password.',
    builtin: false,
    /**
     * Reading the form definitions it has to draw, and nothing else.
     *
     * It does not need to write submissions: a visitor's form posts to the
     * public endpoint, which takes no key at all. Granting it was a mistake —
     * `submissions:write` also reached update and delete, so a key sitting in a
     * page's JavaScript could have edited or destroyed the enquiries it was
     * only supposed to file.
     */
    permissions: ['forms:read'],
  },
  {
    key: 'aiAgent',
    name: 'AI agent',
    description:
      'A program, not a person. Reads the enquiries and the forms through the agent endpoint, and changes neither. Give it a key and narrow that key to the job.',
    builtin: false,
    /**
     * Deliberately read-only, and deliberately narrow.
     *
     * The footgun in setting up a role for an agent is granting something whose
     * consequences you did not picture — and an agent acts faster and more
     * literally than the person who granted it. So this starts where nothing it
     * does is hard to undo, and anything more is a decision somebody makes on
     * purpose rather than one they inherit from a template.
     *
     * The key is where it gets narrowed further: whoever mints one chooses
     * which of these it may use, and the agent discovers exactly that and
     * nothing else.
     */
    permissions: ['forms:read', 'submissions:read'],
  },
  {
    key: 'default',
    name: 'Default user',
    description:
      'Signed in, and their own account details. Everyone starts here; a root admin decides what they become.',
    builtin: true,
    // Narrowed to `self`, so these two reach the person's own profile row and
    // no other. It is the same mechanism that keeps a desk to one form, which
    // is why members needed no separate permission system.
    permissions: ['submissions:read', 'submissions:write'],
    conditions: {
      'submissions:read': { userId: { self: true } },
      'submissions:write': { userId: { self: true } },
    },
  },
]

/**
 * Policies the node ships with.
 *
 * Not a starter pack for its own sake — these are the three shapes every rule a
 * business writes turns out to be a variation of, and having them present means
 * the first one somebody writes is an edit rather than a blank page.
 *
 * None is attached to anything. A policy that took effect by existing would be
 * a surprise; these are attached from the Roles screen, deliberately.
 */
const BUILTIN_POLICIES: Array<{
  key: string
  name: string
  description: string
  effect: string
  permissions: Array<string>
  condition: RoleCondition
}> = [
  {
    key: 'own-records-only',
    name: 'Their own records only',
    description:
      'Reaches the rows that belong to the person asking, and no one else’s. What an ordinary member holds over their own profile.',
    effect: 'allow',
    permissions: ['submissions:read', 'submissions:write'],
    condition: { userId: { self: true } },
  },
  {
    key: 'no-destroying-enquiries',
    name: 'Never destroy enquiries',
    description:
      'Takes away the ability to delete a submission, whatever else the role is given. Attach it to a desk that handles enquiries all day.',
    effect: 'deny',
    permissions: ['submissions:delete'],
    condition: {},
  },
  {
    key: 'read-only',
    name: 'Read only',
    description:
      'Refuses every change: the site, the enquiries, the settings and who has access. A role for someone who needs to see the work, not do it.',
    effect: 'deny',
    permissions: [
      'forms:write',
      'forms:delete',
      'submissions:write',
      'submissions:delete',
      'content:write',
      'config:write',
      'settings:write',
      'features:manage',
      'team:manage',
    ],
    condition: {},
  },
]

/**
 * Seeds the shipped policies, once.
 *
 * Only ever inserted, never reconciled — unlike a built-in role, a policy is a
 * rule about somebody's records, and quietly rewriting one on a deploy could
 * widen access nobody asked to widen. If a business edits `read-only` to mean
 * something else here, it means that.
 */
export async function ensureBuiltinPolicies(db: NodeDb): Promise<void> {
  const existing = await db.select().from(policiesTable)
  const known = new Set(existing.map((row) => row.key))

  for (const policy of BUILTIN_POLICIES) {
    if (known.has(policy.key)) continue
    await db.insert(policiesTable).values({ ...policy, builtin: true })
  }
}

/**
 * Two different promises, which is why `builtin` matters.
 *
 * A built-in role is ours: what a root admin can reach has to grow as the node
 * grows, and a member has to gain their own profile the moment forms learn to
 * hold one. Those are kept current on every read.
 *
 * The rest — designer, operator, frontend — are starting points, and the moment
 * a business has one it is theirs. Reconciling those would quietly undo the
 * afternoon somebody spent deciding what a designer may touch here.
 */
export async function ensureBuiltinRoles(db: NodeDb): Promise<void> {
  await ensureBuiltinPolicies(db)
  const existing = await db.select().from(rolesTable)
  const byKey = new Map(existing.map((row) => [row.key, row]))
  const everything = permissionKeys(await getEnabledFeatures(db))

  for (const role of BUILTIN_ROLES) {
    const permissions = role.all ? everything : (role.permissions ?? [])
    const conditions = role.conditions ?? {}
    const found = byKey.get(role.key)

    if (!found) {
      await db.insert(rolesTable).values({
        key: role.key,
        name: role.name,
        description: role.description,
        permissions,
        conditions,
        builtin: role.builtin,
      })
      continue
    }

    if (!role.builtin) continue

    // Name and description are left alone: a business may call its root admin
    // whatever it likes. Only what the role can reach is ours to keep current.
    const same =
      JSON.stringify(found.permissions ?? []) === JSON.stringify(permissions) &&
      JSON.stringify(found.conditions ?? {}) === JSON.stringify(conditions)
    if (same) continue

    await db
      .update(rolesTable)
      .set({ permissions, conditions })
      .where(eq(rolesTable.key, role.key))
  }
}

/** What a new account gets before anyone decides otherwise. */
export const DEFAULT_ROLE = 'default'

/** A token long enough that guessing it is not a strategy. */
export function newInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface AcceptResult {
  ok: boolean
  error?: string
  email?: string
}

/**
 * Turn an invitation into an account.
 *
 * Sign-up is off on purpose, and this does not turn it on: the token is the
 * invitation, so the only accounts that can appear are ones somebody with
 * `team:manage` deliberately created. The user is built through Better Auth's
 * own adapter so the password is hashed exactly the way sign-in will check it.
 */
export async function acceptInvitation(
  env: NodeEnv,
  db: NodeDb,
  token: string,
  password: string,
  name?: string,
): Promise<AcceptResult> {
  const [invite] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1)

  if (!invite) return { ok: false, error: 'That invitation is not valid.' }
  if (invite.acceptedAt) {
    return { ok: false, error: 'That invitation has already been used.' }
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'That invitation has expired.' }
  }
  if (password.length < 8) {
    return { ok: false, error: 'Use a password of at least 8 characters.' }
  }

  const ctx = await getAuth(env).$context

  const existing = await ctx.adapter.findOne({
    model: 'user',
    where: [{ field: 'email', value: invite.email }],
  })
  if (existing) {
    return { ok: false, error: 'That address already has an account.' }
  }

  const user = await ctx.internalAdapter.createUser({
    email: invite.email,
    name: name?.trim() || invite.email,
    emailVerified: true,
    // The invitation named the role; that is the whole difference between
    // being invited and signing up.
    role: invite.roleKey || DEFAULT_ROLE,
  })
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    accountId: user.id,
    providerId: 'credential',
    password: await ctx.password.hash(password),
  })

  await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.id, invite.id))

  return { ok: true, email: invite.email }
}
