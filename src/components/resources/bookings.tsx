import { useState } from 'react'
import { useNotify, useRecordContext, useRefresh } from 'ra-core'

import { DataTable, List, TextField } from '#/components/admin'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'

/**
 * The diary.
 *
 * Read-only, and that is a property of how appointments work rather than a
 * missing screen. A time is taken by booking it — which writes the rows that
 * make the database refuse a second person the same slot — so an appointment
 * typed straight into a table would occupy no time at all and would be
 * double-booked by the next person to come along.
 *
 * The one thing that can be done from here is calling one off, which gives the
 * time back.
 */

const TONE: Record<string, 'outline' | 'secondary' | 'destructive'> = {
  confirmed: 'outline',
  held: 'secondary',
  cancelled: 'destructive',
  expired: 'destructive',
}

const WORDS: Record<string, string> = {
  confirmed: 'Confirmed',
  held: 'Holding, unpaid',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

const Status = () => {
  const record = useRecordContext<{ status?: string }>()
  const status = record?.status ?? 'held'
  return <Badge variant={TONE[status] ?? 'secondary'}>{WORDS[status] ?? status}</Badge>
}

/** Local time, because a diary is read by somebody sitting somewhere. */
const When = () => {
  const record = useRecordContext<{ startsAt?: string | number }>()
  if (!record?.startsAt) return null
  const at = new Date(record.startsAt)
  return (
    <span className="text-sm">
      {at.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </span>
  )
}

const Cancel = () => {
  const record = useRecordContext<{ reference?: string; status?: string }>()
  const notify = useNotify()
  const refresh = useRefresh()
  const [busy, setBusy] = useState(false)

  if (!record?.reference) return null
  if (record.status === 'cancelled' || record.status === 'expired') return null

  const cancel = async () => {
    setBusy(true)
    const response = await fetch(`/api/bookings/${record.reference}`, {
      method: 'DELETE',
    })
    const body = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) {
      notify(body.error ?? 'Could not cancel it.', { type: 'error' })
      return
    }
    // Said plainly, because the two are genuinely separate and somebody who
    // assumes otherwise finds out from an unhappy customer.
    notify('Cancelled. The time is free again — no money has moved.', {
      type: 'info',
    })
    refresh()
  }

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
      Cancel
    </Button>
  )
}

export const BookingList = () => (
  <List sort={{ field: 'startsAt', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="startsAt" label="When">
        <When />
      </DataTable.Col>
      <DataTable.Col source="buyerName" label="Who" />
      <DataTable.Col source="buyerEmail" label="Email" />
      <DataTable.Col source="status">
        <Status />
      </DataTable.Col>
      <DataTable.Col source="reference">
        <TextField source="reference" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="id" label="">
        <Cancel />
      </DataTable.Col>
    </DataTable>
  </List>
)
