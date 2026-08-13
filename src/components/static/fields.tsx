import {
  ArrayInput,
  BooleanField,
  BooleanInput,
  DataTable,
  NumberInput,
  SelectInput,
  SimpleFormIterator,
  TextField,
  TextInput,
} from '#/components/admin'

/**
 * Sveltia widgets rendered with the kit's inputs.
 *
 * The mapping is deliberately small. Every widget the template uses is here;
 * anything unfamiliar falls back to a text input rather than failing to render,
 * so an unknown config still opens and stays editable — losing formatting is
 * recoverable, refusing to load the page is not.
 */
export interface StaticField {
  name: string
  label: string
  widget: string
  required: boolean
  hint?: string
  options?: Array<string>
  fields?: Array<StaticField>
}

export function inputFor(field: StaticField, prefix = ''): React.ReactElement {
  const source = prefix ? `${prefix}.${field.name}` : field.name
  const shared = {
    key: source,
    source,
    label: field.label,
    helperText: field.hint,
  }

  switch (field.widget) {
    // Carried by the file, not edited here. It still survives a save, because
    // writes merge rather than replace — so `$schema` and friends stay put
    // without cluttering the form.
    case 'hidden':
      return <></>
    case 'text':
      return <TextInput {...shared} multiline />
    case 'number':
      return <NumberInput {...shared} />
    case 'boolean':
      return <BooleanInput {...shared} />
    case 'select':
      return (
        <SelectInput
          {...shared}
          choices={(field.options ?? []).map((option) => ({
            id: option,
            name: option,
          }))}
        />
      )
    case 'image':
      // A path into the repo's media folder, which the site resolves itself.
      return <TextInput {...shared} helperText={field.hint ?? 'Path to an image in the repo'} />
    case 'object':
      return (
        <div key={source} className="flex flex-col gap-3 rounded-md border p-3">
          <p className="text-sm font-medium">{field.label}</p>
          {(field.fields ?? []).map((child) => inputFor(child, source))}
        </div>
      )
    case 'list':
      return field.fields?.length ? (
        <ArrayInput {...shared}>
          <SimpleFormIterator inline>
            {field.fields.map((child) => inputFor(child))}
          </SimpleFormIterator>
        </ArrayInput>
      ) : (
        // A list with no declared shape is a list of plain strings.
        <ArrayInput {...shared}>
          <SimpleFormIterator inline>
            <TextInput source="" label={field.label} />
          </SimpleFormIterator>
        </ArrayInput>
      )
    default:
      return <TextInput {...shared} />
  }
}

/** The columns worth showing in a list — scalars only, in declared order. */
export function columnsFor(fields: Array<StaticField>): React.ReactNode {
  const scalar = fields
    .filter((field) => !['list', 'object'].includes(field.widget))
    .slice(0, 4)

  return (
    <>
      {scalar.map((field) =>
        field.widget === 'boolean' ? (
          <DataTable.Col key={field.name} source={field.name} label={field.label}>
            <BooleanField source={field.name} />
          </DataTable.Col>
        ) : (
          <DataTable.Col key={field.name} source={field.name} label={field.label}>
            <TextField source={field.name} />
          </DataTable.Col>
        ),
      )}
    </>
  )
}
