import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'
import { Copy, KeyRound, UserPlus } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Badge } from '#/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Checkbox } from '#/components/ui/checkbox'
import type { PermissionDefinition } from '#/lib/permission-catalog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'

interface Member {
  id: string
  email: string
  name: string | null
  roleKey: string | null
  isOwner: boolean
}

interface Role {
  id: number
  key: string
  name: string
}

interface ApiKey {
  id: number
  name: string
  prefix: string
  lastUsedAt: string | null
  revokedAt: string | null
}

interface Invitation {
  id: number
  email: string
  roleKey: string
  acceptedAt: string | null
  expiresAt: string
}

/**
 * The keys one account holds.
 *
 * Shown under the person rather than in a tab of their own, because a key is
 * not a thing in its own right — it is a way for something to *be* that
 * account. "What can this key do" and "what can this user do" are one question,
 * so they are one screen.
 */
const Keys = ({ member }: { member: Member }) => {
  const notify = useNotify()
  const [keys, setKeys] = useState<Array<ApiKey>>([])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [origins, setOrigins] = useState('')
  const [minted, setMinted] = useState<string | null>(null)
  // null means "no second gate": the account's own grant is the only limit.
  const [scope, setScope] = useState<Array<string> | null>(null)
  const [catalog, setCatalog] = useState<Array<PermissionDefinition>>([])
  const [held, setHeld] = useState<Array<string>>([])

  const load = () =>
    fetch(`/api/team/${member.id}/keys`)
      .then((response) => (response.ok ? response.json() : []))
      .then(setKeys)
      .catch(() => setKeys([]))

  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // What this node can grant, and what this account actually holds — the second
  // gate can only narrow the first, so offering more than the first would be
  // offering something that cannot happen.
  useEffect(() => {
    if (!open) return
    void fetch('/api/permissions')
      .then((response) => (response.ok ? response.json() : { catalog: [] }))
      .then((body) => setCatalog(body.catalog ?? []))
      .catch(() => setCatalog([]))
    void fetch(`/api/team/${member.id}/permissions`)
      .then((response) => (response.ok ? response.json() : { permissions: [] }))
      .then((body) => setHeld(body.permissions ?? []))
      .catch(() => setHeld([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const mint = async () => {
    const response = await fetch(`/api/team/${member.id}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        allowedOrigins: origins
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        scope: scope === null ? undefined : { permissions: scope },
      }),
    })
    const body = await response.json()
    if (!response.ok) {
      notify(body.error ?? 'Could not mint that.', { type: 'error' })
      return
    }
    setMinted(body.secret)
    setName('')
    setOrigins('')
    setScope(null)
    await load()
  }

  const revoke = async (id: number) => {
    await fetch(`/api/team/${member.id}/keys?key=${id}`, { method: 'DELETE' })
    await load()
  }

  const live = keys.filter((key) => !key.revokedAt)

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
      >
        <KeyRound className="size-3.5" />
        {live.length
          ? `${live.length} key${live.length > 1 ? 's' : ''}`
          : 'API keys'}
      </button>

      {open ? (
        <div className="border-border/70 mt-2 flex flex-col gap-2 rounded-lg border p-3">
          {live.map((key) => (
            <div key={key.id} className="flex items-center gap-2 text-xs">
              <code className="font-mono">ak_{key.prefix}…</code>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {key.name}
                {key.lastUsedAt
                  ? ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                  : ' · never used'}
              </span>
              <Button variant="ghost" size="sm" onClick={() => revoke(key.id)}>
                Revoke
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-[11rem]"
              placeholder="What is it for"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              className="h-8 max-w-[16rem]"
              placeholder="https://yoursite.com (recommended)"
              value={origins}
              onChange={(event) => setOrigins(event.target.value)}
            />
            <Button size="sm" onClick={mint} disabled={!name}>
              Mint a key
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            A key acts as this account and carries its role. Leave the origin
            blank only for a key that stays on a server — one in a browser is
            readable by anyone who views source, and an origin is what makes a
            copy of it worthless elsewhere.
          </p>

          {/*
            The second gate.

            The account's role already decides the most this key could ever do.
            This is the holder deciding what *this* key does — narrower, for one
            job, for one agent. A permission is reachable only if both allow it,
            so nothing ticked here can add anything: unticking is the only thing
            that has an effect.
          */}
          <div className="border-border/70 bg-muted/30 flex flex-col gap-3 rounded-lg border p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={scope !== null}
                onCheckedChange={() =>
                  setScope(scope === null ? [...held] : null)
                }
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">
                  Limit what this key can do
                </span>
                <span className="text-muted-foreground block text-xs">
                  For a key going to an agent: it discovers exactly what is
                  ticked here and nothing else.
                </span>
              </span>
            </label>

            {scope !== null ? (
              <div className="flex flex-col gap-2 pl-6">
                {held.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    This account holds nothing a key could carry.
                  </p>
                ) : null}
                {catalog
                  .filter((permission) => held.includes(permission.key))
                  .map((permission) => (
                    <label
                      key={permission.key}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={scope.includes(permission.key)}
                        onCheckedChange={() =>
                          setScope(
                            scope.includes(permission.key)
                              ? scope.filter((key) => key !== permission.key)
                              : [...scope, permission.key],
                          )
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium">
                          {permission.name}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {permission.description}
                        </span>
                      </span>
                    </label>
                  ))}
                <p className="text-muted-foreground text-xs">
                  Whatever this account loses later, the key loses too — this
                  can only ever take away.
                </p>
              </div>
            ) : null}
          </div>

          {minted ? (
            <div className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-lg border p-3">
              <p className="text-sm font-medium">Copy it now</p>
              <div className="flex items-center gap-2">
                <code className="bg-background min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-xs">
                  {minted}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(minted)
                    notify('Copied.', { type: 'info' })
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                This is the only time it is shown. Only a hash is kept.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Who can reach this node, and how someone else comes to.
 *
 * One screen rather than three, because the questions arrive together: adding
 * a person, saying what they may do, and seeing who already can are the same
 * sitting. Roles get their own screen only because designing one is a separate
 * job from handing it out.
 */
export const TeamPage = () => {
  const notify = useNotify()
  const [members, setMembers] = useState<Array<Member>>([])
  const [roles, setRoles] = useState<Array<Role>>([])
  const [invites, setInvites] = useState<Array<Invitation>>([])
  const [email, setEmail] = useState('')
  const [roleKey, setRoleKey] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const [m, r, i] = await Promise.all([
      fetch('/api/team').then((res) => (res.ok ? res.json() : [])),
      fetch('/api/roles').then((res) => (res.ok ? res.json() : [])),
      fetch('/api/invitations').then((res) => (res.ok ? res.json() : [])),
    ])
    setMembers(m)
    setRoles(r)
    setInvites(i)
    if (!roleKey && r.length) setRoleKey(r[0].key)
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const roleName = (key: string | null) =>
    roles.find((role) => role.key === key)?.name ?? key ?? 'No access'

  const invite = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/invitations/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, roleKey }),
      })
      const body = await response.json()
      if (!response.ok) {
        notify(body.error ?? 'Could not create that invitation.', {
          type: 'error',
        })
        return
      }
      setLink(body.url)
      setEmail('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const setRole = async (id: string, key: string) => {
    const response = await fetch(`/api/team/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleKey: key }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      notify(body.error ?? 'Could not change that.', { type: 'error' })
      return
    }
    await refresh()
  }

  const remove = async (id: string) => {
    const response = await fetch(`/api/team/${id}`, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      notify(body.error ?? 'Could not remove them.', { type: 'error' })
      return
    }
    notify('Access removed.', { type: 'success' })
    await refresh()
  }

  const pending = invites.filter((entry) => !entry.acceptedAt)

  return (
    <div className="flex w-full min-w-0 max-w-4xl flex-col gap-6">
      <h2 className="font-display text-2xl font-semibold tracking-tight">
        Users
      </h2>

      <Card>
        <CardHeader>
          <CardTitle>Invite someone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            The invitation is emailed from this node's own address. The link is
            shown here too, in case the mail does not arrive — it works once and
            expires in seven days.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-xs"
              placeholder="them@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Select value={roleKey} onValueChange={setRoleKey}>
              <SelectTrigger className="w-[190px]">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.key} value={role.key}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={invite} disabled={busy || !email || !roleKey}>
              <UserPlus className="size-4" />
              Create the link
            </Button>
          </div>

          {link ? (
            <div className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-lg border p-3">
              <p className="font-medium">Send them this link</p>
              <div className="flex items-center gap-2">
                <code className="bg-background min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-xs">
                  {link}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(link)
                    notify('Copied.', { type: 'info' })
                  }}
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Shown once. If it is lost, create another — this one keeps
                working until it is used or expires.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who has access</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {members.map((member) => (
            <div
              key={member.id}
              className="border-border/70 flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {member.name || member.email}
                </p>
                <p className="text-muted-foreground truncate font-mono text-xs">
                  {member.email}
                </p>
              </div>

              {member.isOwner ? (
                // Not a select: there is nothing to choose. This is the account
                // the project was created with, and the guaranteed way back in.
                <Badge variant="secondary">Root admin — full access</Badge>
              ) : (
                <>
                  <Select
                    value={member.roleKey ?? ''}
                    onValueChange={(next) => setRole(member.id, next)}
                  >
                    <SelectTrigger className="w-[190px]">
                      <SelectValue placeholder="No access" />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((role) => (
                        <SelectItem key={role.key} value={role.key}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => remove(member.id)}
                  >
                    Remove
                  </Button>
                </>
              )}
              <Keys member={member} />
            </div>
          ))}
        </CardContent>
      </Card>

      {pending.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting to be accepted</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {pending.map((entry) => (
              <div
                key={entry.id}
                className="border-border/70 flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <span className="min-w-0 truncate font-mono text-xs">
                  {entry.email}
                </span>
                <span className="text-muted-foreground text-xs">
                  {roleName(entry.roleKey)} · expires{' '}
                  {new Date(entry.expiresAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
