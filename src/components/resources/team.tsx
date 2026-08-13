import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'
import { Copy, UserPlus } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Badge } from '#/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
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

interface Invitation {
  id: number
  email: string
  roleKey: string
  acceptedAt: string | null
  expiresAt: string
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
    key === 'owner'
      ? 'Owner'
      : (roles.find((role) => role.key === key)?.name ?? key ?? 'No access')

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
        Team
      </h2>

      <Card>
        <CardHeader>
          <CardTitle>Invite someone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            This node cannot send email yet, so an invitation is a link. Send it
            however you already talk to them — it works once and expires in seven
            days.
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
                // Not a select: there is nothing to choose. The owner is the
                // guaranteed way back into the node.
                <Badge variant="secondary">Owner — full access</Badge>
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
