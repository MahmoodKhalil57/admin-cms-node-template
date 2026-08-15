import { useEffect, useState } from 'react'
import { useNotify, useRecordContext } from 'ra-core'
import { UserPlus } from 'lucide-react'

import {
  Create,
  DataTable,
  Edit,
  List,
  SelectInput,
  SimpleForm,
  TextField,
  TextInput,
} from '#/components/admin'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

/**
 * The businesses selling on this node.
 *
 * One row on a single-vendor node and hardly worth a screen; many on a
 * marketplace, and then this is where each one is set up. What a vendor may
 * reach is not decided here — it is decided by the role they hold and the
 * policy attached to it, the same way everything else on this node is.
 */

const STATUSES = [
  { id: 'active', name: 'Selling' },
  { id: 'suspended', name: 'Suspended — keeps its rows, takes no money' },
]

interface VendorMember {
  id: number
  userId: string
  email: string | null
  name: string | null
}

/**
 * Who acts for this vendor.
 *
 * Beneath the vendor rather than under Users, because "which people are this
 * business" is a question about the business. Adding somebody needs
 * `vendors:manage`, so a vendor editing their own storefront cannot hand their
 * access to anyone.
 */
const Members = () => {
  const record = useRecordContext<{ id: number }>()
  const notify = useNotify()
  const [members, setMembers] = useState<Array<VendorMember>>([])
  const [accounts, setAccounts] = useState<Array<{ id: string; email: string }>>([])
  const [chosen, setChosen] = useState('')

  const load = () => {
    if (!record?.id) return
    void fetch(`/api/vendors/${record.id}/members`)
      .then((response) => (response.ok ? response.json() : []))
      .then(setMembers)
      .catch(() => setMembers([]))
  }

  useEffect(() => {
    load()
    void fetch('/api/team')
      .then((response) => (response.ok ? response.json() : []))
      .then(setAccounts)
      .catch(() => setAccounts([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id])

  if (!record?.id) return null

  const add = async () => {
    const response = await fetch(`/api/vendors/${record.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: chosen }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      notify(body.error ?? 'Could not add them.', { type: 'error' })
      return
    }
    setChosen('')
    load()
  }

  const remove = async (userId: string) => {
    await fetch(`/api/vendors/${record.id}/members?user=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    })
    load()
  }

  const held = new Set(members.map((member) => member.userId))

  return (
    <div className="border-border/70 bg-muted/30 flex w-full min-w-0 flex-col gap-3 rounded-lg border p-4">
      <p className="text-sm font-medium">Who acts for this vendor</p>
      <p className="text-muted-foreground text-xs">
        These accounts see this business's rows and nobody else's — the same
        role for every vendor, resolved to whoever is asking.
      </p>

      {members.map((member) => (
        <div key={member.id} className="flex items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {member.name || member.email || member.userId}
          </span>
          <Button variant="ghost" size="sm" onClick={() => remove(member.userId)}>
            Remove
          </Button>
        </div>
      ))}
      {members.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nobody yet.</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          list="vendor-accounts"
          className="h-8 max-w-xs"
          placeholder="them@example.com"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        />
        <datalist id="vendor-accounts">
          {accounts
            .filter((account) => !held.has(account.id))
            .map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
              </option>
            ))}
        </datalist>
        <Button size="sm" onClick={add} disabled={!chosen}>
          <UserPlus className="size-4" />
          Add
        </Button>
      </div>
    </div>
  )
}

const Status = () => {
  const record = useRecordContext<{ status?: string }>()
  return (
    <Badge variant={record?.status === 'suspended' ? 'destructive' : 'outline'}>
      {record?.status === 'suspended' ? 'Suspended' : 'Selling'}
    </Badge>
  )
}

export const VendorList = () => (
  <List sort={{ field: 'id', order: 'ASC' }}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="slug">
        <TextField source="slug" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="status">
        <Status />
      </DataTable.Col>
      <DataTable.Col source="email" />
    </DataTable>
  </List>
)

const VendorForm = () => (
  <div className="flex w-full min-w-0 flex-col gap-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput source="name" required />
      <TextInput
        source="slug"
        className="[&_input]:font-mono"
        helperText="What a storefront URL says. Changing it changes their address."
      />
    </div>
    <TextInput source="description" multiline helperText={false} />
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput
        source="email"
        helperText="Where this vendor hears about their own sales."
      />
      <SelectInput source="status" choices={STATUSES} />
    </div>
    {/* Left empty on purpose for almost everybody: empty means this vendor is
        charged whatever the node charges, so changing the node's rate moves
        them with it. A number here pins them to their own deal. */}
    <TextInput
      source="commissionBps"
      label="Commission, in basis points"
      helperText="What this node keeps from their sales. 250 is 2.5%. Leave it empty to use the node's rate, and set 0 to take nothing."
    />
    <Members />
  </div>
)

export const VendorEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-3xl">
      <VendorForm />
    </SimpleForm>
  </Edit>
)

export const VendorCreate = () => (
  <Create>
    <SimpleForm className="max-w-3xl" defaultValues={{ status: 'active' }}>
      <VendorForm />
    </SimpleForm>
  </Create>
)
