import { Resource } from 'ra-core'
import { tanStackRouterProvider } from 'ra-router-tanstack'
import {
  BellRing,
  FileText,
  Scale,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from 'lucide-react'

import { Admin } from '#/components/admin'
import { NodeLayout } from '#/components/node-layout'
import { LoginPage } from '#/components/login-page'
import { SettingsPage } from '#/components/settings-page'
import { authProvider } from '#/lib/auth-provider'
import { dataProvider } from '#/lib/data-provider'
import { useEnabledFeatures } from '#/lib/features'
import { useStaticModel } from '#/lib/static-model'
import {
  staticCreate,
  staticEdit,
  staticList,
} from '#/components/static/screens'
import { BuilderOverlay } from '#/components/static/builder'
import { RoleCreate, RoleEdit, RoleList } from '#/components/resources/roles'
import {
  PolicyCreate,
  PolicyEdit,
  PolicyList,
} from '#/components/resources/policies'
import { ProfileGate } from '#/components/profile-gate'
import {
  AutomationCreate,
  AutomationEdit,
  AutomationList,
  NotificationList,
} from '#/components/resources/automations'
import { TeamPage } from '#/components/resources/team'
import { holds, useMyPermissions } from '#/lib/my-permissions'
import { FeatureEdit, FeatureList } from '#/components/resources/features'
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
  const staticModel = useStaticModel()
  // Every hook before the early return below. React counts them per render, and
  // the loading branch would otherwise run fewer of them than the loaded one.
  const mine = useMyPermissions()

  if (enabled === null || mine === null) {
    return (
      <div className="text-muted-foreground flex min-h-screen items-center justify-center text-sm">
        Loading…
      </div>
    )
  }

  const forms = enabled.includes('forms')
  // `mine` is what this person may reach. Cosmetic on its own — every one of
  // these is checked again on the server — but a panel offering screens that
  // answer 403 is worse than one that does not offer them.
  const team = enabled.includes('user-management')

  return (
    <>
      {/* Outside <Admin>, which renders only the children it recognises —
          a <Resource> or a <CustomRoutes>, and nothing else. One overlay for
          the whole panel: any entry can open it, and it is the same surface
          every time. */}
      <BuilderOverlay />
      <ProfileGate />
      <Admin
        basename="/admin"
        routerProvider={tanStackRouterProvider}
        dataProvider={dataProvider}
        authProvider={authProvider}
        loginPage={NodeLoginPage}
        layout={NodeLayout}
        requireAuth
        disableTelemetry
        title="Node admin"
      >
        {forms && holds(mine, 'forms:read') && (
          <Resource
            name="forms"
            list={FormList}
            edit={FormEdit}
            create={FormCreate}
            show={FormShow}
            recordRepresentation="name"
          />
        )}
        {forms && holds(mine, 'submissions:read') && (
          <Resource
            name="submissions"
            list={SubmissionList}
            show={SubmissionShow}
          />
        )}
        {forms && holds(mine, 'submissions:read') && (
          <Resource
            name="automations"
            options={{ label: 'Notifications' }}
            list={AutomationList}
            edit={AutomationEdit}
            create={AutomationCreate}
            icon={BellRing}
            recordRepresentation="name"
          />
        )}
        {forms && holds(mine, 'submissions:read') && (
          <Resource
            name="notifications"
            options={{ label: 'Sent' }}
            list={NotificationList}
            icon={Send}
          />
        )}
        {/* The site's own content, edited straight in its repository — the same
          files its static CMS writes, so either surface produces the same
          commits. Collections come from the repo at runtime, which is why they
          are mapped rather than listed. */}
        {holds(mine, 'content:read') &&
          (staticModel?.collections ?? []).map((collection) => (
            <Resource
              key={collection.name}
              name={`static/${collection.name}`}
              options={{ label: collection.label, group: 'Static' }}
              list={staticList(collection)}
              edit={staticEdit(collection, staticModel?.siteUrl ?? '')}
              create={
                collection.canCreate ? staticCreate(collection) : undefined
              }
              icon={FileText}
            />
          ))}

        {team && holds(mine, 'team:read') && (
          <Resource
            name="team"
            options={{ label: 'Users', group: 'Users' }}
            list={TeamPage}
            icon={Users}
          />
        )}
        {team && holds(mine, 'team:manage') && (
          <Resource
            name="roles"
            options={{ label: 'Roles', group: 'Users' }}
            list={RoleList}
            edit={RoleEdit}
            create={RoleCreate}
            icon={ShieldCheck}
            recordRepresentation="name"
          />
        )}
        {/* Below Roles, because that is the order they are read in: a policy is
          reached through the role that carries it. */}
        {team && holds(mine, 'team:manage') && (
          <Resource
            name="policies"
            options={{ label: 'Policies', group: 'Users' }}
            list={PolicyList}
            edit={PolicyEdit}
            create={PolicyCreate}
            icon={Scale}
            recordRepresentation="name"
          />
        )}

        {/* Node-wide, so always present: a node's addresses belong to the node,
          not to whichever feature happens to use them. */}
        {holds(mine, 'settings:read') && (
          <Resource
            name="settings"
            options={{ label: 'Settings' }}
            list={SettingsPage}
            icon={SlidersHorizontal}
          />
        )}
        {/* Always registered for anyone who may manage them — switching a
          feature off must not remove the way to switch it back on. */}
        {holds(mine, 'features:manage') && (
          <Resource
            name="features"
            options={{ label: 'Features' }}
            list={FeatureList}
            edit={FeatureEdit}
            icon={Settings2}
            recordRepresentation="key"
          />
        )}
      </Admin>
    </>
  )
}
