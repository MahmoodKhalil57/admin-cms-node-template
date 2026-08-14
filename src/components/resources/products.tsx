import { useState } from 'react'
import { useNotify, useRecordContext } from 'ra-core'
import { Upload } from 'lucide-react'

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
import { Button } from '#/components/ui/button'

/**
 * What this node sells.
 *
 * Prices are entered and shown in the smallest unit — 1500 rather than 15.00 —
 * because that is what is stored, what is charged and what is refunded, and a
 * field that quietly multiplies by a hundred is a field somebody eventually
 * gets wrong by a factor of a hundred. Said in the hint rather than hidden.
 */

const STATUSES = [
  { id: 'draft', name: 'Draft — not for sale' },
  { id: 'published', name: 'Published — buyable' },
  { id: 'retired', name: 'Retired — keeps its orders' },
]

/** The file a buyer receives, streamed straight to the node's own bucket. */
const AssetUpload = () => {
  const record = useRecordContext<{ id: number }>()
  const notify = useNotify()
  const [busy, setBusy] = useState(false)

  if (!record?.id) {
    return (
      <p className="text-muted-foreground text-xs">
        Save this first, then upload the file buyers receive.
      </p>
    )
  }

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const response = await fetch(
        `/api/products/${record.id}/asset?filename=${encodeURIComponent(file.name)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        },
      )
      const body = await response.json().catch(() => ({}))
      notify(
        response.ok ? `Uploaded ${body.filename}.` : (body.error ?? 'Upload failed.'),
        { type: response.ok ? 'success' : 'error' },
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-border/70 bg-muted/30 flex w-full flex-col gap-2 rounded-lg border p-4">
      <p className="text-sm font-medium">The file buyers receive</p>
      <p className="text-muted-foreground text-xs">
        Kept in this node's own storage and never served directly — a buyer gets
        a link that checks their purchase every time it is opened.
      </p>
      <label className="mt-1">
        <input
          type="file"
          className="hidden"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void upload(file)
          }}
        />
        <Button asChild variant="outline" size="sm" disabled={busy}>
          <span className="cursor-pointer">
            <Upload className="size-4" />
            {busy ? 'Uploading…' : 'Choose a file'}
          </span>
        </Button>
      </label>
    </div>
  )
}

const Price = () => {
  const record = useRecordContext<{ price?: number }>()
  return (
    <span className="font-mono text-xs">{record?.price ?? 0}</span>
  )
}

const Status = () => {
  const record = useRecordContext<{ status?: string }>()
  return (
    <Badge variant={record?.status === 'published' ? 'outline' : 'secondary'}>
      {record?.status ?? 'draft'}
    </Badge>
  )
}

export const ProductList = () => (
  <List sort={{ field: 'id', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="slug">
        <TextField source="slug" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="price" label="Price (smallest unit)">
        <Price />
      </DataTable.Col>
      <DataTable.Col source="status">
        <Status />
      </DataTable.Col>
    </DataTable>
  </List>
)

const ProductForm = () => (
  <div className="flex w-full min-w-0 flex-col gap-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <TextInput source="name" required />
      <TextInput
        source="slug"
        className="[&_input]:font-mono"
        helperText="What a storefront link says."
      />
    </div>
    <TextInput source="blurb" multiline helperText={false} />
    <div className="grid gap-4 sm:grid-cols-2">
      <NumberInput
        source="price"
        helperText="In the smallest unit: 1500 is £15.00. Whole numbers only."
      />
      <SelectInput source="status" choices={STATUSES} />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <NumberInput
        source="downloadLimit"
        helperText="How many times one purchase may be downloaded."
      />
      <NumberInput
        source="downloadDays"
        helperText="How long the link keeps working, in days."
      />
    </div>
    <AssetUpload />
  </div>
)

export const ProductEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-3xl">
      <ProductForm />
    </SimpleForm>
  </Edit>
)

export const ProductCreate = () => (
  <Create>
    <SimpleForm
      className="max-w-3xl"
      defaultValues={{ status: 'draft', price: 0, downloadLimit: 5, downloadDays: 30 }}
    >
      <ProductForm />
    </SimpleForm>
  </Create>
)
