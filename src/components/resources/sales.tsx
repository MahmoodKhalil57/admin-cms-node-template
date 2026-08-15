import { useRecordContext } from 'ra-core'

import { DataTable, List } from '#/components/admin'

/**
 * Every line of every order.
 *
 * The screen a vendor actually wants, and the reason it is lines rather than
 * orders: one order can carry several vendors, so `vendorId` lives on the line.
 * A rule saying `vendorId is mine` narrows this table and cannot narrow the
 * order table, which is why "show me my sales" needed a resource of its own
 * rather than a filter on an existing one.
 *
 * The three money columns are the whole story of a marketplace sale: what the
 * buyer paid, what the vendor is owed, and what the platform kept. All three
 * are written at the moment of sale and never recomputed, so this agrees with
 * the receipt however the rates have changed since.
 */

const Money = ({ source }: { source: string }) => {
  const record = useRecordContext<Record<string, unknown>>()
  const value = Number(record?.[source] ?? 0)
  return <span className="font-mono text-sm tabular-nums">{value}</span>
}

export const SaleList = () => (
  <List sort={{ field: 'id', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="name" label="What sold" />
      <DataTable.Col source="quantity" />
      <DataTable.Col source="amount" label="Line total">
        <Money source="amount" />
      </DataTable.Col>
      <DataTable.Col source="vendorShare" label="Vendor's share">
        <Money source="vendorShare" />
      </DataTable.Col>
      <DataTable.Col source="platformFee" label="Platform's cut">
        <Money source="platformFee" />
      </DataTable.Col>
    </DataTable>
  </List>
)
