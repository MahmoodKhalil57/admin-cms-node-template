import { Resource } from 'ra-core'
import { tanStackRouterProvider } from 'ra-router-tanstack'
import { Settings2, SlidersHorizontal } from 'lucide-react'

import { Admin } from '#/components/admin'
import { LoginPage } from '#/components/login-page'
import { SettingsPage } from '#/components/settings-page'
import { authProvider } from '#/lib/auth-provider'
import { dataProvider } from '#/lib/data-provider'
import { useEnabledFeatures } from '#/lib/features'
import {
  FeatureEdit,
  FeatureList,
} from '#/components/resources/features'
import {
  FormCreate,
  FormEdit,
  FormList,
  FormShow,
} from '#/components/resources/forms'
import {
  SubmissionList,
  SubmissionShow,
} from '#/components/resources/submissions'

const NodeLoginPage = () => (
  <LoginPage title="Node admin" subtitle="Sign in to manage this node" />
)

/**
 * The node console.
 *
 * Mounted from both `/` and the `/$` splat so react-admin's client-side URLs
 * resolve — with only an index route they are a router 404. Both set
 * `ssr: false`: the vendored kit's `breadcrumb.tsx` reads `document` during
 * render, and `ra-router-tanstack` falls back to a hash history when it can't
 * find a router, so this subtree must not be server-rendered.
 *
 * `disableTelemetry` stops the vendored `<Admin>` beaconing this node's
 * hostname to marmelab in production.
 *
 * Which features are on is the node's own decision, read from its database at
 * runtime rather than baked in at build time. Resources are registered once the
 * answer arrives, because ra-core reads its `<Resource>` children when `<Admin>`
 * mounts — rendering them before the state is known would register the wrong
 * set.
 *
 * Hiding a `<Resource>` is only cosmetic. The API enforces the same gate
 * independently, because a hidden resource is still a reachable URL.
 */
export function AdminApp() {
  const enabled = useEnabledFeatures()

  if (enabled === null) {
    return (
      <div className="text-muted-foreground flex min-h-screen items-center justify-center text-sm">
        Loading…
      </div>
    )
  }

  const forms = enabled.includes('forms')

  return (
    <Admin
      routerProvider={tanStackRouterProvider}
      dataProvider={dataProvider}
      authProvider={authProvider}
      loginPage={NodeLoginPage}
      requireAuth
      disableTelemetry
      title="Node admin"
    >
      {forms && (
        <Resource
          name="forms"
          list={FormList}
          edit={FormEdit}
          create={FormCreate}
          show={FormShow}
          recordRepresentation="name"
        />
      )}
      {forms && (
        <Resource
          name="submissions"
          list={SubmissionList}
          show={SubmissionShow}
        />
      )}
      {/* Node-wide, so always present: a node's addresses belong to the node,
          not to whichever feature happens to use them. */}
      <Resource
        name="settings"
        options={{ label: 'Settings' }}
        list={SettingsPage}
        icon={SlidersHorizontal}
      />
      {/* Always registered — switching a feature off must not remove the way
          to switch it back on. */}
      <Resource
        name="features"
        options={{ label: 'Features' }}
        list={FeatureList}
        edit={FeatureEdit}
        icon={Settings2}
        recordRepresentation="key"
      />
    </Admin>
  )
}
