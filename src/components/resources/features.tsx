import { useRecordContext } from 'ra-core'
import { Lock } from 'lucide-react'

import {
  BooleanField,
  BooleanInput,
  DataTable,
  Edit,
  List,
  SimpleForm,
  TextField,
} from '#/components/admin'
import { GithubPagesPanel } from '#/components/features/github-pages-panel'
import { ProjectsPanel } from '#/components/features/projects-panel'
import { featureDefinition } from '#/lib/feature-catalog'
import { invalidateFeatures } from '#/lib/features'

interface FeatureRecord {
  id: number
  key: string
  enabled: boolean
}

/** The catalog's human name for a feature row, falling back to its key. */
const FeatureName = () => {
  const record = useRecordContext<FeatureRecord>()
  return <span>{featureDefinition(record?.key ?? '')?.name ?? record?.key}</span>
}

const FeatureDescription = () => {
  const record = useRecordContext<FeatureRecord>()
  const definition = featureDefinition(record?.key ?? '')
  return (
    <span className="text-muted-foreground">
      {definition?.description ?? 'Not available in this build.'}
    </span>
  )
}

/**
 * The switch, or the reason there is not one.
 *
 * Three of these are part of what a node is rather than things it may also do:
 * being the back end of a website, taking money, and knowing who may do what.
 * Turning one off does not make a smaller node, it makes a broken one — so the
 * screen says so instead of showing a control that would be refused.
 */
const FeatureSwitch = () => {
  const record = useRecordContext<FeatureRecord>()
  const definition = featureDefinition(record?.key ?? '')

  if (!definition?.alwaysOn) return <BooleanInput source="enabled" />

  return (
    <div className="border-border/70 bg-muted/30 flex items-start gap-2.5 rounded-lg border p-3">
      <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium">Always on</p>
        <p className="text-muted-foreground text-xs">
          This is part of what a node is, not something it may also do. It
          cannot be switched off.
        </p>
      </div>
    </div>
  )
}

/**
 * A feature's own settings, shown beneath its switch.
 *
 * Features configure themselves here rather than each growing a collection of
 * its own, so everything about a feature is on one page. A feature with nothing
 * to configure simply renders nothing.
 */
const FeatureConfig = () => {
  const record = useRecordContext<FeatureRecord>()
  if (!record) return null

  // Settings are meaningless while the feature is off, and showing them would
  // imply they apply.
  if (!record.enabled) {
    return (
      <p className="text-muted-foreground text-sm">
        Turn this on to configure it.
      </p>
    )
  }

  switch (record.key) {
    case 'github-pages':
      return <GithubPagesPanel featureId={record.id} />
    case 'projects':
      return <ProjectsPanel featureId={record.id} />
    default:
      return null
  }
}

export const FeatureList = () => (
  <List sort={{ field: 'key', order: 'ASC' }} pagination={false}>
    <DataTable>
      <DataTable.Col source="key" label="Feature">
        <FeatureName />
      </DataTable.Col>
      <DataTable.Col source="key" label="What it does">
        <FeatureDescription />
      </DataTable.Col>
      <DataTable.Col source="enabled">
        <BooleanField source="enabled" />
      </DataTable.Col>
    </DataTable>
  </List>
)

export const FeatureEdit = () => (
  <Edit
    mutationMode="pessimistic"
    mutationOptions={{
      // Turning a feature on or off changes which `<Resource>` elements exist,
      // and ra-core registers those once when <Admin> mounts. Reloading is the
      // honest way to re-register them — re-rendering alone leaves the sidebar
      // and routes describing the previous state.
      onSuccess: () => {
        invalidateFeatures()
        window.location.reload()
      },
    }}
  >
    <SimpleForm>
      <TextField source="key" />
      <FeatureDescription />
      <FeatureSwitch />
    </SimpleForm>
    <div className="px-4 pb-6">
      <FeatureConfig />
    </div>
  </Edit>
)
