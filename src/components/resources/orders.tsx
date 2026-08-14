import { useRecordContext } from 'ra-core'

import {
  DataTable,
  DateField,
  List,
  Show,
  SimpleShowLayout,
  TextField,
} from '#/components/admin'
import { Badge } from '#/components/ui/badge'

/**
 * The takings.
 *
 * Read-only, and not because nobody is trusted: an order is what the payment
 * provider said happened, and a status typed in here would be a claim about
 * somebody else's money. Refunds are made through the provider, and arrive back
 * as a webhook like everything else.
 */

const TONE: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  paid: 'outline',
  pending: 'secondary',
  failed: 'destructive',
  refunded: 'destructive',
}

const Status = () => {
  const record = useRecordContext<{ status?: string }>()
  const status = record?.status ?? 'pending'
  return <Badge variant={TONE[status] ?? 'secondary'}>{status}</Badge>
}

/** Shown as stored — an integer in the smallest unit. */
const Amount = ({ source }: { source: string }) => {
  const record = useRecordContext<Record<string, unknown>>()
  return (
    <span className="font-mono text-xs">
      {String(record?.[source] ?? 0)} {String(record?.currency ?? '')}
    </span>
  )
}

export const OrderList = () => (
  <List sort={{ field: 'id', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="reference">
        <TextField source="reference" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="status">
        <Status />
      </DataTable.Col>
      <DataTable.Col source="total">
        <Amount source="total" />
      </DataTable.Col>
      <DataTable.Col source="buyerEmail" />
      <DataTable.Col source="createdAt">
        <DateField source="createdAt" showTime />
      </DataTable.Col>
    </DataTable>
  </List>
)

export const OrderShow = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="reference" className="font-mono" />
      <TextField source="status" />
      <TextField source="currency" />
      <TextField source="total" />
      <TextField source="refundedTotal" />
      <TextField source="buyerEmail" />
      <DateField source="paidAt" showTime />
    </SimpleShowLayout>
  </Show>
)
