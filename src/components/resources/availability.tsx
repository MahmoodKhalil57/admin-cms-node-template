import { useRecordContext } from 'ra-core'

import {
  Create,
  DataTable,
  Edit,
  List,
  NumberInput,
  SelectInput,
  SimpleForm,
  TextInput,
} from '#/components/admin'

/**
 * When somebody is normally available.
 *
 * A weekly pattern, one row per stretch of a day — two rows for a morning and
 * an afternoon with lunch between them, which is why this is a list rather than
 * a form with seven fields.
 *
 * **The timezone is the field that matters most and looks least important.** A
 * rule is a description of a wall clock, not of an instant: "Tuesdays at nine"
 * is a different moment in January than in July, and the zone is what says
 * which nine is meant. Storing an offset instead would move every winter
 * appointment by an hour once the clocks changed.
 */

const WEEKDAYS = [
  { id: 0, name: 'Sunday' },
  { id: 1, name: 'Monday' },
  { id: 2, name: 'Tuesday' },
  { id: 3, name: 'Wednesday' },
  { id: 4, name: 'Thursday' },
  { id: 5, name: 'Friday' },
  { id: 6, name: 'Saturday' },
]

/** Whatever the browser is in, first — it is right far more often than not. */
const ZONES = (() => {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const common = [
    here,
    'UTC',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Dubai',
    'Asia/Riyadh',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Australia/Sydney',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
  ]
  return [...new Set(common)].map((zone) => ({ id: zone, name: zone }))
})()

function clock(minutes: number | undefined): string {
  if (minutes === undefined || minutes === null) return ''
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

const Hours = () => {
  const record = useRecordContext<{
    startMinute?: number
    endMinute?: number
    timezone?: string
  }>()
  if (!record) return null
  return (
    <span className="text-sm">
      {clock(record.startMinute)} – {clock(record.endMinute)}{' '}
      <span className="text-muted-foreground text-xs">{record.timezone}</span>
    </span>
  )
}

const Day = () => {
  const record = useRecordContext<{ weekday?: number }>()
  return <span>{WEEKDAYS[record?.weekday ?? 0]?.name ?? '—'}</span>
}

export const AvailabilityList = () => (
  <List sort={{ field: 'weekday', order: 'ASC' }}>
    <DataTable>
      <DataTable.Col source="weekday" label="Day">
        <Day />
      </DataTable.Col>
      <DataTable.Col source="startMinute" label="Open">
        <Hours />
      </DataTable.Col>
    </DataTable>
  </List>
)

const AvailabilityForm = () => (
  <div className="flex w-full min-w-0 flex-col gap-5">
    <SelectInput source="weekday" choices={WEEKDAYS} label="Day" />
    <div className="grid gap-4 sm:grid-cols-2">
      <NumberInput
        source="startMinute"
        label="Opens (minutes after midnight)"
        helperText="540 is 09:00."
      />
      <NumberInput
        source="endMinute"
        label="Closes (minutes after midnight)"
        helperText="1020 is 17:00."
      />
    </div>
    <SelectInput
      source="timezone"
      choices={ZONES}
      label="Timezone"
      helperText="Which clock these hours are on. Appointments are stored as instants, so this is what decides when nine o'clock is."
    />
    <TextInput
      source="vendorId"
      label="Vendor"
      helperText="Leave empty on a single-vendor node. On a marketplace, whose diary this is."
    />
  </div>
)

export const AvailabilityEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-2xl">
      <AvailabilityForm />
    </SimpleForm>
  </Edit>
)

export const AvailabilityCreate = () => (
  <Create>
    <SimpleForm
      className="max-w-2xl"
      defaultValues={{
        weekday: 1,
        startMinute: 540,
        endMinute: 1020,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      }}
    >
      <AvailabilityForm />
    </SimpleForm>
  </Create>
)
