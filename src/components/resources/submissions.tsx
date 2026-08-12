import { useRecordContext } from 'ra-core'

import {
  DataTable,
  DateField,
  List,
  ReferenceField,
  Show,
  SimpleShowLayout,
  TextField,
} from '#/components/admin'

export const SUBMISSION_STATUSES = [
  { id: 'new', name: 'New' },
  { id: 'read', name: 'Read' },
  { id: 'spam', name: 'Spam' },
  { id: 'archived', name: 'Archived' },
]

/**
 * Renders a submission's `data` blob.
 *
 * Submissions are stored keyed by field name rather than in typed columns,
 * because a form's field list can change after submissions already exist. So
 * this reads whatever keys the row actually has instead of the form's current
 * definition — an old submission stays readable after its form is edited.
 */
const SubmissionData = () => {
  const record = useRecordContext<{ data?: Record<string, unknown> }>()
  const entries = Object.entries(record?.data ?? {})

  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No data submitted.</p>
  }

  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground font-medium">{key}</dt>
          <dd className="break-words">
            {typeof value === 'object' && value !== null
              ? JSON.stringify(value)
              : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export const SubmissionList = () => (
  <List sort={{ field: 'id', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="formId" label="Form">
        <ReferenceField source="formId" reference="forms" />
      </DataTable.Col>
      <DataTable.Col source="status" />
      <DataTable.Col source="createdAt">
        <DateField source="createdAt" showTime />
      </DataTable.Col>
    </DataTable>
  </List>
)

export const SubmissionShow = () => (
  <Show>
    <SimpleShowLayout>
      <ReferenceField source="formId" reference="forms" />
      <TextField source="status" />
      <DateField source="createdAt" showTime />
      <SubmissionData />
    </SimpleShowLayout>
  </Show>
)
