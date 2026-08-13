import { useEffect } from 'react'
import { useRecordContext, useRedirect } from 'ra-core'

import {
  Create,
  DataTable,
  Edit,
  List,
  SimpleForm,
  TextField,
} from '#/components/admin'
import type { StaticCollection } from '#/lib/static-model'
import { columnsFor, inputFor } from '#/components/static/fields'
import { StaticPreview } from '#/components/static/preview'
import { FormPreview } from '#/components/static/form-preview'

/**
 * List, edit and create screens built from a collection's declared fields.
 *
 * Generated rather than hand-written, because the fields come from the site's
 * own config — a hand-written screen would only match the template it was
 * written against.
 */
export function staticList(collection: StaticCollection) {
  const only =
    collection.kind === 'files' && collection.files?.length === 1
      ? collection.files[0].name
      : undefined

  // A collection of exactly one file is a singleton: there is nothing to pick
  // between, so the list would be a single row standing between the operator
  // and the only thing they came for. Send them straight to it.
  if (only) {
    return function StaticSingleton() {
      const redirect = useRedirect()
      useEffect(() => {
        redirect('edit', `static/${collection.name}`, only)
      }, [redirect])
      return null
    }
  }

  return function StaticList() {
    return (
      <List
        resource={`static/${collection.name}`}
        pagination={false}
        // A fixed set of files has nothing to filter or sort.
        exporter={false}
      >
        <DataTable>
          <DataTable.Col source="id" label="Name">
            <TextField source="id" className="font-mono text-xs" />
          </DataTable.Col>
          {columnsFor(collection.fields)}
        </DataTable>
      </List>
    )
  }
}

/**
 * The fields for the entry being edited.
 *
 * In a `files` collection each file declares its own shape, so the form has to
 * be chosen by which entry is open rather than fixed for the collection.
 */
const EntryForm = ({ collection }: { collection: StaticCollection }) => {
  const record = useRecordContext<{ id: string }>()

  const fields =
    collection.kind === 'files'
      ? (collection.files?.find((file) => file.name === record?.id)?.fields ??
        collection.fields)
      : collection.fields

  return <>{fields.map((field) => inputFor(field))}</>
}

export function staticEdit(collection: StaticCollection, siteUrl: string) {
  // Which preview belongs beside this collection. The site frame can paint the
  // pages it serves; it cannot paint a file the pages never read, so that
  // collection says so in the config rather than being previewed misleadingly.
  const preview =
    collection.preview === 'forms' ? (
      <FormPreview />
    ) : siteUrl ? (
      <StaticPreview collection={collection.name} siteUrl={siteUrl} />
    ) : null

  return function StaticEdit() {
    return (
      <Edit resource={`static/${collection.name}`} mutationMode="pessimistic">
        {/*
          One form, two columns — not two forms.
          The preview reads the live form values, and react-hook-form scopes
          those to the nearest form context. Putting the preview in a second
          <SimpleForm> gives it that form's (empty) state, so it renders once
          and then never moves again no matter what is typed on the left.

          `max-w-none` undoes the kit's 32rem cap, which a two-pane editor
          cannot live inside; `minmax(0, …)` on both tracks is what stops a
          deeply nested field from pushing its column over the preview.
        */}
        <SimpleForm className="max-w-none gap-0">
          <div
            className={
              preview
                ? 'grid w-full min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]'
                : 'grid w-full min-w-0 gap-8'
            }
          >
            <div className="flex min-w-0 flex-col gap-6">
              <EntryForm collection={collection} />
            </div>
            {preview}
          </div>
        </SimpleForm>
      </Edit>
    )
  }
}

export function staticCreate(collection: StaticCollection) {
  return function StaticCreate() {
    return (
      <Create resource={`static/${collection.name}`}>
        <SimpleForm className="max-w-2xl">
          <div className="flex w-full min-w-0 flex-col gap-6">
            {collection.fields.map((field) => inputFor(field))}
          </div>
        </SimpleForm>
      </Create>
    )
  }
}
