import { Resource } from 'ra-core'
import { tanStackRouterProvider } from 'ra-router-tanstack'

import { Admin } from '#/components/admin'
import { dataProvider } from '#/lib/data-provider'
import { hasFeature } from '#/lib/features'
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
 * A feature that is off contributes no `<Resource>`, and the sidebar follows
 * automatically because it maps `useResourceDefinitions()`. The matching
 * server-side check still has to exist — see `#/lib/features`.
 */
export function AdminApp() {
  const forms = hasFeature('forms')

  return (
    <Admin
      routerProvider={tanStackRouterProvider}
      dataProvider={dataProvider}
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
    </Admin>
  )
}
