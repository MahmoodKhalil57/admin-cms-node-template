import { useEffect, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useRecordContext } from 'ra-core'

import {
  Create,
  DataTable,
  DeleteButton,
  Edit,
  List,
  SaveButton,
  SimpleForm,
  TextField,
  TextInput,
} from '#/components/admin'
import { Checkbox } from '#/components/ui/checkbox'
import { Badge } from '#/components/ui/badge'
import type { PermissionDefinition } from '#/lib/permission-catalog'
import { cn } from '#/lib/utils'

/**
 * A role, as the business defines it.
 *
 * The permission list is fetched rather than compiled in: what a node can grant
 * depends on which features it has switched on, so a role editor built from a
 * hard-coded list would offer permissions that do nothing.
 */
function usePermissionCatalog() {
  const [catalog, setCatalog] = useState<Array<PermissionDefinition>>([])
  useEffect(() => {
    fetch('/api/permissions')
      .then((response) => (response.ok ? response.json() : { catalog: [] }))
      .then((body) => setCatalog(body.catalog ?? []))
      .catch(() => setCatalog([]))
  }, [])
  return catalog
}

/**
 * The permission grid.
 *
 * Grouped by area and written as sentences, because the person choosing is
 * describing a job — "reads the enquiries, does not change the website" — and a
 * column of `submissions:read` does not say that.
 */
const PermissionPicker = ({
  value,
  onChange,
  catalog,
}: {
  value: Array<string>
  onChange: (next: Array<string>) => void
  catalog: Array<PermissionDefinition>
}) => {
  const areas = [...new Set(catalog.map((permission) => permission.area))]

  const toggle = (key: string) =>
    onChange(
      value.includes(key)
        ? value.filter((held) => held !== key)
        : [...value, key],
    )

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      {areas.map((area) => (
        <fieldset
          key={area}
          className="border-border/70 bg-muted/30 min-w-0 rounded-lg border p-4"
        >
          <legend className="text-muted-foreground px-1.5 text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
            {area}
          </legend>
          <div className="flex flex-col gap-3">
            {catalog
              .filter((permission) => permission.area === area)
              .map((permission) => (
                <label
                  key={permission.key}
                  className="flex cursor-pointer items-start gap-3"
                >
                  <Checkbox
                    checked={value.includes(permission.key)}
                    onCheckedChange={() => toggle(permission.key)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {permission.name}
                      <code className="text-muted-foreground/70 font-mono text-[0.7rem]">
                        {permission.key}
                      </code>
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {permission.description}
                    </span>
                  </span>
                </label>
              ))}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

/**
 * Narrowing a grant to particular records.
 *
 * This is what makes one role usable by five people who must not see each
 * other's work: the same "reads submissions" job, pointed at different forms.
 * Only offered for permissions the catalog says can be scoped — the rest are
 * all-or-nothing and pretending otherwise would invite a rule that never
 * applies.
 */
const ScopePicker = ({
  permissions,
  conditions,
  onChange,
  catalog,
}: {
  permissions: Array<string>
  conditions: Record<string, Record<string, { in?: Array<string | number> }>>
  onChange: (next: Record<string, unknown>) => void
  catalog: Array<PermissionDefinition>
}) => {
  const scopable = catalog.filter(
    (permission) =>
      permission.scopes?.length && permissions.includes(permission.key),
  )
  if (!scopable.length) return null

  const setScope = (key: string, field: string, raw: string) => {
    const values = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    const next = { ...conditions }
    if (!values.length) {
      const remaining = { ...next[key] }
      delete remaining[field]
      if (Object.keys(remaining).length) next[key] = remaining
      else delete next[key]
    } else {
      next[key] = { ...next[key], [field]: { in: values } }
    }
    onChange(next)
  }

  return (
    <fieldset className="border-border/70 bg-muted/30 min-w-0 rounded-lg border p-4">
      <legend className="text-muted-foreground px-1.5 text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
        Limit to certain records
      </legend>
      <p className="text-muted-foreground mb-3 text-xs">
        Leave blank to allow all of them.
      </p>
      <div className="flex flex-col gap-4">
        {scopable.map((permission) =>
          (permission.scopes ?? []).map((scope) => (
            <div key={`${permission.key}:${scope.field}`} className="min-w-0">
              <p className="mb-1 text-sm font-medium">
                {permission.name}
                <span className="text-muted-foreground font-normal">
                  {' — '}
                  {scope.label}
                </span>
              </p>
              <input
                className="border-input bg-background focus-visible:ring-ring/60 h-9 w-full rounded-md border px-3 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none"
                placeholder="3, 4"
                defaultValue={(
                  conditions[permission.key]?.[scope.field]?.in ?? []
                ).join(', ')}
                onChange={(event) =>
                  setScope(permission.key, scope.field, event.target.value)
                }
              />
            </div>
          )),
        )}
      </div>
    </fieldset>
  )
}

interface PolicyRow {
  id: number
  key: string
  name: string
  description: string | null
  effect: string
  permissions: Array<string>
}

/**
 * The policies this role carries.
 *
 * Placed above the permission grid on purpose. The grid is where a one-off is
 * written; this is where a rule the business already agreed on is picked up, and
 * reaching for the second before the first is the habit worth encouraging.
 */
const PolicyPicker = ({
  value,
  onChange,
}: {
  value: Array<string>
  onChange: (next: Array<string>) => void
}) => {
  const [policies, setPolicies] = useState<Array<PolicyRow>>([])

  useEffect(() => {
    fetch('/api/policies?range=[0,199]')
      .then((response) => (response.ok ? response.json() : []))
      .then((rows) => setPolicies(Array.isArray(rows) ? rows : []))
      .catch(() => setPolicies([]))
  }, [])

  if (!policies.length) return null

  const toggle = (key: string) =>
    onChange(
      value.includes(key)
        ? value.filter((held) => held !== key)
        : [...value, key],
    )

  return (
    <fieldset className="border-border/70 bg-muted/30 min-w-0 rounded-lg border p-4">
      <legend className="text-muted-foreground px-1.5 text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
        Policies
      </legend>
      <p className="text-muted-foreground mb-3 text-xs">
        Rules kept in one place and shared between roles. A refusal beats
        anything granted below.
      </p>
      <div className="flex flex-col gap-3">
        {policies.map((policy) => (
          <label
            key={policy.key}
            className="flex cursor-pointer items-start gap-3"
          >
            <Checkbox
              checked={value.includes(policy.key)}
              onCheckedChange={() => toggle(policy.key)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {policy.name}
                <Badge
                  variant={policy.effect === 'deny' ? 'destructive' : 'outline'}
                >
                  {policy.effect === 'deny' ? 'Refuses' : 'Allows'}
                </Badge>
              </span>
              <span className="text-muted-foreground block text-xs">
                {policy.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

const RoleForm = () => {
  const catalog = usePermissionCatalog()
  const record = useRecordContext<{ builtin?: boolean }>()
  const { setValue } = useFormContext()
  const permissions = (useWatch({ name: 'permissions' }) ?? []) as Array<string>
  const attached = (useWatch({ name: 'policies' }) ?? []) as Array<string>
  const conditions = (useWatch({ name: 'conditions' }) ?? {}) as Record<
    string,
    Record<string, { in?: Array<string | number> }>
  >

  // Written straight into the surrounding form's store: the pickers below stand
  // for whole objects rather than single fields, so there is no input to bind.
  const setField = (name: string, value: unknown) =>
    setValue(name, value, { shouldDirty: true })

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      {record?.builtin ? (
        <p className="border-primary/40 bg-primary/5 rounded-lg border p-3 text-sm">
          This role comes with the node. It can be renamed but not deleted —
          something has to be able to reach everything.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput source="name" required />
        <TextInput
          source="key"
          className="[&_input]:font-mono"
          helperText="Stored on each member. Renaming the role is safe; changing this is not."
        />
      </div>
      <TextInput source="description" multiline helperText={false} />

      <PolicyPicker
        value={attached}
        onChange={(next) => setField('policies', next)}
      />
      <div className="min-w-0">
        <p className="mb-2 text-sm font-medium">And on top of those</p>
        <PermissionPicker
          catalog={catalog}
          value={permissions}
          onChange={(next) => setField('permissions', next)}
        />
      </div>
      <ScopePicker
        catalog={catalog}
        permissions={permissions}
        conditions={conditions}
        onChange={(next) => setField('conditions', next)}
      />
    </div>
  )
}

export const RoleList = () => (
  <List sort={{ field: 'id', order: 'ASC' }} exporter={false}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="key">
        <TextField source="key" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="permissions" label="Can do">
        <PermissionCount />
      </DataTable.Col>
      <DataTable.Col source="description" />
    </DataTable>
  </List>
)

const PermissionCount = () => {
  const record = useRecordContext<{
    permissions?: Array<string>
    builtin?: boolean
  }>()
  const held = record?.permissions?.length ?? 0
  return (
    <span className="flex items-center gap-2">
      <Badge variant="outline">
        {held === 1 ? '1 thing' : `${held} things`}
      </Badge>
      {record?.builtin ? (
        <span className={cn('text-muted-foreground text-xs')}>built in</span>
      ) : null}
    </span>
  )
}

export const RoleEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-3xl" toolbar={<RoleToolbar />}>
      <RoleForm />
    </SimpleForm>
  </Edit>
)

export const RoleCreate = () => (
  <Create>
    <SimpleForm
      className="max-w-3xl"
      defaultValues={{ permissions: [], conditions: {}, policies: [] }}
    >
      <RoleForm />
    </SimpleForm>
  </Create>
)

/** Deleting a built-in role is refused rather than offered and then rejected. */
const RoleToolbar = () => {
  const record = useRecordContext<{ builtin?: boolean }>()
  return (
    <div className="flex w-full flex-row items-center justify-between gap-2">
      <span>{record?.builtin ? null : <DeleteButton />}</span>
      <SaveButton />
    </div>
  )
}
