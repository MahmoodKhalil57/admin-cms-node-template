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
export const FORM_TARGETS = [
  { id: 'public', name: 'Anyone — a new row each time' },
  { id: 'profile', name: 'The account — one row per person' },
]

const WIDTHS = [
  { id: 'full', name: 'Full' },
  { id: 'half', name: 'Half' },
]

const FIELD_TYPES = [
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
    <SimpleFormIterator>
      <div className="grid w-full gap-3 sm:grid-cols-2">
        <TextInput
          source="name"
          label="Key"
          helperText="How the value is stored in a submission"
          className="[&_input]:font-mono"
        />
        <TextInput source="label" />
        <SelectInput source="type" choices={FIELD_TYPES} />
        <TextInput source="placeholder" helperText={false} />
        <BooleanInput source="required" />
        <SelectInput source="width" choices={WIDTHS} helperText="On the site" />
      </div>
      {/* Same shape the site's declaration uses, so a field survives a round
          trip through either editor unchanged. */}
      <ArrayInput source="options" label="Choices" helperText="Only for a Select field">
        <SimpleFormIterator inline>
          <TextInput source="value" className="[&_input]:font-mono" />
          <TextInput source="label" />
        </SimpleFormIterator>
      </ArrayInput>
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
      <SelectInput
        source="target"
        label="What it collects"
        choices={FORM_TARGETS}
        defaultValue="public"
        helperText="A profile form belongs to whoever fills it: one row each, edited rather than resent."
      />
      <BooleanInput
        source="requiredAtSignup"
        label="Ask for it at sign-up"
        helperText="Profile forms only. The site asks before letting someone get on."
      />
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
      <SelectInput
        source="target"
        label="What it collects"
        choices={FORM_TARGETS}
        defaultValue="public"
        helperText="A profile form belongs to whoever fills it: one row each, edited rather than resent."
      />
      <BooleanInput
        source="requiredAtSignup"
        label="Ask for it at sign-up"
        helperText="Profile forms only. The site asks before letting someone get on."
      />
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
