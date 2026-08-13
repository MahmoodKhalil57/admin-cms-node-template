import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { invitations, roles as rolesTable } from '#/db/schema'
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
  },
  {
    key: 'frontend',
    name: 'Frontend',
    description:
      'A website, not a person. Reads the form definitions it has to draw and files what visitors send. Holds an API key rather than a password.',
    builtin: false,
    permissions: ['forms:read', 'submissions:write'],
  },
  {
    key: 'default',
    name: 'Default user',
    description:
      'Signed in, and nothing more. Everyone starts here; a root admin decides what they become.',
    builtin: true,
    permissions: [],
  },
]

export async function ensureBuiltinRoles(db: NodeDb): Promise<void> {
  const existing = await db.select().from(rolesTable)
  const known = new Set(existing.map((row) => row.key))
  const everything = permissionKeys(await getEnabledFeatures(db))

  for (const role of BUILTIN_ROLES) {
    if (known.has(role.key)) continue
    await db.insert(rolesTable).values({
      key: role.key,
      name: role.name,
      description: role.description,
      permissions: role.all ? everything : (role.permissions ?? []),
      conditions: {},
      builtin: role.builtin,
    })
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
