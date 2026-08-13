import { useEffect, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useRecordContext } from 'ra-core'
import { ShieldBan, ShieldCheck } from 'lucide-react'

import {
  Create,
  DataTable,
  DeleteButton,
  Edit,
  List,
  SaveButton,
  SelectInput,
  SimpleForm,
  TextField,
  TextInput,
} from '#/components/admin'
import { Checkbox } from '#/components/ui/checkbox'
import { Badge } from '#/components/ui/badge'
import type { PermissionDefinition } from '#/lib/permission-catalog'

/**
 * A policy: one rule about records, written once and attached to any number of
 * roles.
 *
 * The screen is deliberately narrower than the role editor. A role is a job
 * description and needs the whole permission grid; a policy is a sentence —
 * *these permissions, over these records, allowed or refused* — and reads best
 * when it is only ever that.
 */

export const POLICY_EFFECTS = [
  { id: 'allow', name: 'Allow — widens what a role reaches' },
  { id: 'deny', name: 'Refuse — narrows it, and wins any disagreement' },
]

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

/** Which permissions the rule speaks about. */
const Subjects = ({
  value,
  onChange,
  catalog,
}: {
  value: Array<string>
  onChange: (next: Array<string>) => void
  catalog: Array<PermissionDefinition>
}) => {
  const areas = [...new Set(catalog.map((permission) => permission.area))]
  const everything = value.includes('*')

  const toggle = (key: string) =>
    onChange(
      value.includes(key)
        ? value.filter((held) => held !== key)
        : [...value, key],
    )

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <label className="border-border/70 bg-muted/30 flex cursor-pointer items-start gap-3 rounded-lg border p-3">
        <Checkbox
          checked={everything}
          onCheckedChange={() => onChange(everything ? [] : ['*'])}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">Everything</span>
          <span className="text-muted-foreground block text-xs">
            Covers every permission the node offers, including ones added later.
          </span>
        </span>
      </label>

      {everything ? null : (
        <div className="flex flex-col gap-4">
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
      )}
    </div>
  )
}

/**
 * Which records the rule speaks about.
 *
 * One condition for the whole policy rather than one per permission, which is
 * what separates this screen from the role editor: a policy is a single
 * sentence, and "the wholesale enquiries" should not have to be said three
 * times because three permissions are involved.
 */
const Records = ({
  condition,
  onChange,
  catalog,
  permissions,
}: {
  condition: Record<string, { in?: Array<string | number>; self?: boolean }>
  onChange: (next: Record<string, unknown>) => void
  catalog: Array<PermissionDefinition>
  permissions: Array<string>
}) => {
  const covered = permissions.includes('*')
    ? catalog
    : catalog.filter((permission) => permissions.includes(permission.key))

  // Every scope the chosen permissions know about, each named once.
  const scopes = [
    ...new Map(
      covered
        .flatMap((permission) => permission.scopes ?? [])
        .map((scope) => [scope.field, scope]),
    ).values(),
  ]
  if (!scopes.length) return null

  const setScope = (field: string, raw: string) => {
    const values = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    const next = { ...condition }
    if (values.length) next[field] = { in: values }
    else delete next[field]
    onChange(next)
  }

  const toggleSelf = (field: string) => {
    const next = { ...condition }
    if (next[field]?.self) delete next[field]
    else next[field] = { self: true }
    onChange(next)
  }

  return (
    <fieldset className="border-border/70 bg-muted/30 min-w-0 rounded-lg border p-4">
      <legend className="text-muted-foreground px-1.5 text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
        Which records
      </legend>
      <p className="text-muted-foreground mb-3 text-xs">
        Leave every box empty for a rule about all of them.
      </p>
      <div className="flex flex-col gap-4">
        {scopes.map((scope) => (
          <div key={scope.field} className="min-w-0">
            <p className="mb-1 text-sm font-medium">{scope.label}</p>
            <input
              className="border-input bg-background focus-visible:ring-ring/60 h-9 w-full rounded-md border px-3 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
              placeholder="3, 4"
              disabled={Boolean(condition[scope.field]?.self)}
              defaultValue={(condition[scope.field]?.in ?? []).join(', ')}
              onChange={(event) => setScope(scope.field, event.target.value)}
            />
            {scope.field === 'userId' ? (
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
                <Checkbox
                  checked={Boolean(condition[scope.field]?.self)}
                  onCheckedChange={() => toggleSelf(scope.field)}
                />
                Whoever is asking — their own rows, resolved per person
              </label>
            ) : null}
          </div>
        ))}
      </div>
    </fieldset>
  )
}

const PolicyForm = () => {
  const catalog = usePermissionCatalog()
  const record = useRecordContext<{ builtin?: boolean }>()
  const { setValue } = useFormContext()
  const permissions = (useWatch({ name: 'permissions' }) ?? []) as Array<string>
  const effect = (useWatch({ name: 'effect' }) ?? 'allow') as string
  const condition = (useWatch({ name: 'condition' }) ?? {}) as Record<
    string,
    { in?: Array<string | number>; self?: boolean }
  >

  const setField = (name: string, value: unknown) =>
    setValue(name, value, { shouldDirty: true })

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      {record?.builtin ? (
        <p className="border-primary/40 bg-primary/5 rounded-lg border p-3 text-sm">
          This policy came with the node as a starting point. Editing it is
          fine — nothing here overwrites it later.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput source="name" required />
        <TextInput
          source="key"
          className="[&_input]:font-mono"
          helperText="How roles refer to it. Renaming the policy is safe; changing this detaches it."
        />
      </div>
      <TextInput
        source="description"
        multiline
        helperText="What this rule is for, in the words the business uses."
      />
      <SelectInput source="effect" choices={POLICY_EFFECTS} isRequired />

      {effect === 'deny' ? (
        <p className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm">
          A refusal beats every grant beside it. Attach this to a role and what
          it names is out of reach, whatever else that role is given afterwards.
        </p>
      ) : null}

      <Subjects
        catalog={catalog}
        value={permissions}
        onChange={(next) => setField('permissions', next)}
      />
      <Records
        catalog={catalog}
        permissions={permissions}
        condition={condition}
        onChange={(next) => setField('condition', next)}
      />
    </div>
  )
}

const Effect = () => {
  const record = useRecordContext<{ effect?: string; builtin?: boolean }>()
  const deny = record?.effect === 'deny'
  return (
    <span className="flex items-center gap-2">
      <Badge variant={deny ? 'destructive' : 'outline'}>
        {deny ? (
          <ShieldBan className="size-3.5" />
        ) : (
          <ShieldCheck className="size-3.5" />
        )}
        {deny ? 'Refuses' : 'Allows'}
      </Badge>
      {record?.builtin ? (
        <span className="text-muted-foreground text-xs">built in</span>
      ) : null}
    </span>
  )
}

const Covers = () => {
  const record = useRecordContext<{
    permissions?: Array<string>
    condition?: Record<string, unknown>
  }>()
  const held = record?.permissions ?? []
  const scoped = Object.keys(record?.condition ?? {}).length > 0
  return (
    <span className="text-muted-foreground text-xs">
      {held.includes('*')
        ? 'everything'
        : held.length === 1
          ? '1 permission'
          : `${held.length} permissions`}
      {scoped ? ', over certain records' : ''}
    </span>
  )
}

export const PolicyList = () => (
  <List sort={{ field: 'id', order: 'ASC' }} exporter={false}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="effect" label="Effect">
        <Effect />
      </DataTable.Col>
      <DataTable.Col source="permissions" label="Covers">
        <Covers />
      </DataTable.Col>
      <DataTable.Col source="key">
        <TextField source="key" className="font-mono text-xs" />
      </DataTable.Col>
    </DataTable>
  </List>
)

export const PolicyEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-3xl" toolbar={<PolicyToolbar />}>
      <PolicyForm />
    </SimpleForm>
  </Edit>
)

export const PolicyCreate = () => (
  <Create>
    <SimpleForm
      className="max-w-3xl"
      defaultValues={{ effect: 'allow', permissions: [], condition: {} }}
    >
      <PolicyForm />
    </SimpleForm>
  </Create>
)

const PolicyToolbar = () => (
  <div className="flex w-full flex-row items-center justify-between gap-2">
    {/* A policy is deletable even when it shipped with the node: unlike a role,
        nothing is left holding nothing if it goes. */}
    <DeleteButton />
    <SaveButton />
  </div>
)
