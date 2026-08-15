import { useRecordContext } from 'ra-core'

import {
  Create,
  DataTable,
  Edit,
  List,
  NumberInput,
  SelectInput,
  SimpleForm,
  TextField,
  TextInput,
} from '#/components/admin'
import { Badge } from '#/components/ui/badge'

/**
 * What can be booked.
 *
 * A service is an agreement to be somewhere at a time, which is why almost
 * every field here is about time rather than about the thing being sold. The
 * price is the smallest part of it.
 *
 * On a marketplace each vendor's services are their own, by the same policy
 * condition that scopes their products — there is nothing on this screen about
 * vendors because there is nothing that needs to be.
 */

const STATUSES = [
  { id: 'draft', name: 'Draft — nobody can book it' },
  { id: 'published', name: 'Published — taking bookings' },
  { id: 'retired', name: 'Retired — keeps its appointments, takes no new ones' },
]

const Status = () => {
  const record = useRecordContext<{ status?: string }>()
  const published = record?.status === 'published'
  return (
    <Badge variant={published ? 'outline' : 'secondary'}>
      {published ? 'Taking bookings' : (record?.status ?? 'draft')}
    </Badge>
  )
}

const Duration = () => {
  const record = useRecordContext<{
    durationMinutes?: number
    bufferMinutes?: number
  }>()
  if (!record) return null
  const buffer = record.bufferMinutes ?? 0
  return (
    <span className="text-sm">
      {record.durationMinutes} min
      {buffer > 0 ? (
        <span className="text-muted-foreground"> + {buffer} after</span>
      ) : null}
    </span>
  )
}

export const ServiceList = () => (
  <List sort={{ field: 'id', order: 'ASC' }}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="slug">
        <TextField source="slug" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="durationMinutes" label="Length">
        <Duration />
      </DataTable.Col>
      <DataTable.Col source="price" />
      <DataTable.Col source="status">
        <Status />
      </DataTable.Col>
    </DataTable>
  </List>
)

const ServiceForm = () => (
  <div className="flex w-full min-w-0 flex-col gap-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput source="name" required />
      <TextInput
        source="slug"
        className="[&_input]:font-mono"
        helperText="What a booking page's URL says."
      />
    </div>
    <TextInput source="blurb" multiline label="Description" helperText={false} />

    <div className="grid gap-4 sm:grid-cols-2">
      <NumberInput
        source="price"
        helperText="In the smallest unit — 2500 is £25.00. Zero books straight away, with no payment step."
      />
      <SelectInput source="status" choices={STATUSES} />
    </div>

    <div className="border-border/70 bg-muted/30 flex flex-col gap-4 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">How the time is used</p>
        <p className="text-muted-foreground text-xs">
          The gap afterwards is held too. A minute somebody else can book into
          is not a gap.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberInput
          source="durationMinutes"
          label="Length (minutes)"
          helperText="In steps of five."
        />
        <NumberInput
          source="bufferMinutes"
          label="Gap afterwards (minutes)"
          helperText="Travel, notes, clearing up."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberInput
          source="leadMinutes"
          label="Shortest notice (minutes)"
          helperText="No appointments in ten minutes."
        />
        <NumberInput
          source="horizonDays"
          label="How far ahead (days)"
          helperText="How much of the diary is open."
        />
        <NumberInput
          source="holdMinutes"
          label="Hold while paying (minutes)"
          helperText="Then the time goes back."
        />
      </div>
    </div>
  </div>
)

export const ServiceEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-3xl">
      <ServiceForm />
    </SimpleForm>
  </Edit>
)

export const ServiceCreate = () => (
  <Create>
    <SimpleForm
      className="max-w-3xl"
      defaultValues={{
        status: 'draft',
        price: 0,
        durationMinutes: 30,
        bufferMinutes: 0,
        leadMinutes: 120,
        horizonDays: 60,
        holdMinutes: 15,
      }}
    >
      <ServiceForm />
    </SimpleForm>
  </Create>
)
