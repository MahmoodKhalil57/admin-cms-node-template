import { useEffect, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useRecordContext } from 'ra-core'

import {
  BooleanField,
  BooleanInput,
  Create,
  DataTable,
  DateField,
  Edit,
  List,
  SelectInput,
  SimpleForm,
  TextField,
  TextInput,
} from '#/components/admin'
import { Badge } from '#/components/ui/badge'
import { Checkbox } from '#/components/ui/checkbox'
import { CHANNEL_CATALOG, TRIGGER_CATALOG } from '#/lib/automation-catalog'
import type { PermissionDefinition } from '#/lib/permission-catalog'

/**
 * An automation: when this happens, tell these people, this way.
 *
 * The editor asks the three questions in the order someone thinks of them —
 * what happened, who cares, how do they hear — rather than in the order the row
 * stores them.
 */

interface Form {
  id: number
  name: string
  slug: string
}
interface Role {
  key: string
  name: string
}
interface Member {
  id: string
  email: string
  name: string | null
  isOwner: boolean
}

function useDirectory() {
  const [forms, setForms] = useState<Array<Form>>([])
  const [roles, setRoles] = useState<Array<Role>>([])
  const [members, setMembers] = useState<Array<Member>>([])
  const [permissions, setPermissions] = useState<Array<PermissionDefinition>>(
    [],
  )

  useEffect(() => {
    const read = (url: string) =>
      fetch(url).then((response) => (response.ok ? response.json() : []))
    void Promise.all([
      read('/api/forms?range=%5B0%2C99%5D'),
      read('/api/roles?range=%5B0%2C99%5D'),
      read('/api/team'),
      fetch('/api/permissions').then((r) =>
        r.ok ? r.json() : { catalog: [] },
      ),
    ]).then(([f, r, m, p]) => {
      setForms(f)
      setRoles(r)
      setMembers(m)
      setPermissions(p.catalog ?? [])
    })
  }, [])

  return { forms, roles, members, permissions }
}

const Group = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) => (
  <fieldset className="border-border/70 bg-muted/30 min-w-0 rounded-lg border p-4">
    <legend className="text-muted-foreground px-1.5 text-[0.7rem] font-semibold tracking-[0.08em] uppercase">
      {label}
    </legend>
    {hint ? <p className="text-muted-foreground mb-3 text-xs">{hint}</p> : null}
    <div className="flex min-w-0 flex-col gap-3">{children}</div>
  </fieldset>
)

const Tick = ({
  checked,
  onChange,
  title,
  note,
  mono,
}: {
  checked: boolean
  onChange: () => void
  title: string
  note?: string
  mono?: string
}) => (
  <label className="flex cursor-pointer items-start gap-3">
    <Checkbox checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    <span className="min-w-0">
      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {title}
        {mono ? (
          <code className="text-muted-foreground/70 font-mono text-[0.7rem]">
            {mono}
          </code>
        ) : null}
      </span>
      {note ? (
        <span className="text-muted-foreground block text-xs">{note}</span>
      ) : null}
    </span>
  </label>
)

const AutomationForm = () => {
  const { forms, roles, members, permissions } = useDirectory()
  const { setValue } = useFormContext()

  const when = (useWatch({ name: 'when' }) ?? {}) as Record<
    string,
    { in?: Array<string | number> }
  >
  const audience = (useWatch({ name: 'audience' }) ?? {}) as Record<
    string,
    Array<string>
  >
  const channels = (useWatch({ name: 'channels' }) ?? []) as Array<string>

  const set = (name: string, value: unknown) =>
    setValue(name, value, { shouldDirty: true })

  const toggleIn = (bucket: string, value: string) => {
    const held = audience[bucket] ?? []
    set('audience', {
      ...audience,
      [bucket]: held.includes(value)
        ? held.filter((entry) => entry !== value)
        : [...held, value],
    })
  }

  const chosenForms = (when.formId?.in ?? []).map(String)
  const toggleForm = (id: string) => {
    const next = chosenForms.includes(id)
      ? chosenForms.filter((entry) => entry !== id)
      : [...chosenForms, id]
    // No forms chosen means every form — an automation with no narrowing is one
    // the operator wants on all of them.
    set('when', next.length ? { ...when, formId: { in: next } } : {})
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput source="name" required helperText="What this is for" />
        <SelectInput
          source="event"
          label="When"
          choices={TRIGGER_CATALOG.map((trigger) => ({
            id: trigger.key,
            name: trigger.name,
          }))}
          defaultValue="submission.created"
        />
      </div>
      <BooleanInput source="enabled" helperText={false} />

      <Group
        label="Which forms"
        hint="Leave all unticked to fire on every form."
      >
        {forms.map((form) => (
          <Tick
            key={form.id}
            checked={chosenForms.includes(String(form.id))}
            onChange={() => toggleForm(String(form.id))}
            title={form.name}
            mono={form.slug}
          />
        ))}
      </Group>

      {/* Three ways to name the same audience, each surviving a different kind
          of change: a person leaves, a job changes hands, or the org chart is
          redrawn. */}
      <Group
        label="Tell these people"
        hint="Worked out when it fires, not when you save — so a role gaining a member tells them too."
      >
        <p className="text-xs font-semibold">By name</p>
        {members.map((member) => (
          <Tick
            key={member.id}
            checked={(audience.people ?? []).includes(member.id)}
            onChange={() => toggleIn('people', member.id)}
            title={member.name || member.email}
            mono={member.email}
            note={member.isOwner ? 'Owner' : undefined}
          />
        ))}

        <p className="mt-2 text-xs font-semibold">By role</p>
        {roles.map((role) => (
          <Tick
            key={role.key}
            checked={(audience.roles ?? []).includes(role.key)}
            onChange={() => toggleIn('roles', role.key)}
            title={role.name}
            mono={role.key}
            note="Whoever holds it at the time."
          />
        ))}

        <p className="mt-2 text-xs font-semibold">
          By what they are allowed to do
        </p>
        {permissions
          .filter((permission) => permission.key.startsWith('submissions:'))
          .map((permission) => (
            <Tick
              key={permission.key}
              checked={(audience.policies ?? []).includes(permission.key)}
              onChange={() => toggleIn('policies', permission.key)}
              title={`Anyone who can ${permission.name.toLowerCase()}`}
              mono={permission.key}
              note="Respects how their role is narrowed — a desk scoped to one form hears about that form only."
            />
          ))}

        <p className="mt-2 text-xs font-semibold">Or an address</p>
        <TextInput
          source="audience.addresses"
          label={false}
          helperText="For people with no account here. Comma-separated."
          format={(value: Array<string> | undefined) =>
            (value ?? []).join(', ')
          }
          parse={(value: string) =>
            value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
          }
        />
      </Group>

      <Group label="How">
        {CHANNEL_CATALOG.map((channel) => (
          <Tick
            key={channel.key}
            checked={channels.includes(channel.key)}
            onChange={() =>
              set(
                'channels',
                channels.includes(channel.key)
                  ? channels.filter((entry) => entry !== channel.key)
                  : [...channels, channel.key],
              )
            }
            title={
              channel.available ? channel.name : `${channel.name} — not yet`
            }
            note={channel.description}
          />
        ))}
      </Group>
    </div>
  )
}

const Channels = () => {
  const record = useRecordContext<{ channels?: Array<string> }>()
  return (
    <span className="flex flex-wrap gap-1">
      {(record?.channels ?? []).map((channel) => (
        <Badge key={channel} variant="outline">
          {channel}
        </Badge>
      ))}
    </span>
  )
}

export const AutomationList = () => (
  <List sort={{ field: 'id', order: 'DESC' }} exporter={false}>
    <DataTable>
      <DataTable.Col source="name" />
      <DataTable.Col source="event" />
      <DataTable.Col source="channels" label="How">
        <Channels />
      </DataTable.Col>
      <DataTable.Col source="enabled">
        <BooleanField source="enabled" />
      </DataTable.Col>
    </DataTable>
  </List>
)

export const AutomationEdit = () => (
  <Edit mutationMode="pessimistic">
    <SimpleForm className="max-w-3xl">
      <AutomationForm />
    </SimpleForm>
  </Edit>
)

export const AutomationCreate = () => (
  <Create>
    <SimpleForm
      className="max-w-3xl"
      defaultValues={{
        event: 'submission.created',
        enabled: true,
        when: {},
        audience: {},
        channels: ['email'],
      }}
    >
      <AutomationForm />
    </SimpleForm>
  </Create>
)

/**
 * What actually went out.
 *
 * Read-only and deliberately plain. The question it answers is "was this person
 * told", which is only worth asking about attempts that already happened.
 */
export const NotificationList = () => (
  <List sort={{ field: 'id', order: 'DESC' }} exporter={false}>
    <DataTable>
      <DataTable.Col source="createdAt">
        <DateField source="createdAt" showTime />
      </DataTable.Col>
      <DataTable.Col source="channel" />
      <DataTable.Col source="target">
        <TextField source="target" className="font-mono text-xs" />
      </DataTable.Col>
      <DataTable.Col source="status" />
      <DataTable.Col source="detail" />
    </DataTable>
  </List>
)
