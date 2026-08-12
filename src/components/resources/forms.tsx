import {
  ArrayInput,
  BooleanInput,
  Create,
  DataTable,
  DateField,
  Edit,
  List,
  ReferenceManyField,
  SelectInput,
  Show,
  SimpleForm,
  SimpleFormIterator,
  SimpleShowLayout,
  TextField,
  TextInput,
} from '#/components/admin'

export const FORM_STATUSES = [
  { id: 'draft', name: 'Draft' },
  { id: 'published', name: 'Published' },
  { id: 'paused', name: 'Paused' },
]

/** Field types a form can contain, matching `FormFieldDef` in the schema. */
export const FIELD_TYPES = [
  { id: 'text', name: 'Text' },
  { id: 'email', name: 'Email' },
  { id: 'tel', name: 'Phone' },
  { id: 'url', name: 'URL' },
  { id: 'textarea', name: 'Long text' },
  { id: 'number', name: 'Number' },
  { id: 'select', name: 'Select' },
  { id: 'checkbox', name: 'Checkbox' },
  { id: 'date', name: 'Date' },
]

export const FormList = () => (
  <List sort={{ field: 'id', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="slug" />
      <DataTable.Col source="status" />
      <DataTable.Col source="createdAt">
        <DateField source="createdAt" showTime />
      </DataTable.Col>
    </DataTable>
  </List>
)

/**
 * The field builder. `fields` is a JSON column, so `ArrayInput` edits it in
 * place and the whole list is written back with the form.
 */
const FormFields = () => (
  <ArrayInput source="fields">
    <SimpleFormIterator inline>
      <TextInput source="name" helperText="Key used in submissions" />
      <TextInput source="label" />
      <SelectInput source="type" choices={FIELD_TYPES} />
      <BooleanInput source="required" />
    </SimpleFormIterator>
  </ArrayInput>
)

export const FormCreate = () => (
  <Create>
    <SimpleForm>
      <TextInput source="name" required />
      <TextInput
        source="slug"
        required
        helperText="How the public API addresses this form."
      />
      <SelectInput source="status" choices={FORM_STATUSES} />
      <TextInput source="successMessage" />
      <FormFields />
    </SimpleForm>
  </Create>
)

export const FormEdit = () => (
  <Edit>
    <SimpleForm>
      <TextInput source="name" required />
      <TextInput source="slug" required />
      <SelectInput source="status" choices={FORM_STATUSES} />
      <TextInput source="successMessage" />
      <FormFields />
    </SimpleForm>
  </Edit>
)

export const FormShow = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="name" />
      <TextField source="slug" />
      <TextField source="status" />
      <TextField source="successMessage" />
      <DateField source="createdAt" showTime />
      <ReferenceManyField
        reference="submissions"
        target="formId"
        sort={{ field: 'id', order: 'DESC' }}
      >
        <DataTable>
          <DataTable.Col source="id" />
          <DataTable.Col source="status" />
          <DataTable.Col source="createdAt">
            <DateField source="createdAt" showTime />
          </DataTable.Col>
        </DataTable>
      </ReferenceManyField>
    </SimpleShowLayout>
  </Show>
)
