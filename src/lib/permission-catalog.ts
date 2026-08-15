/**
 * Everything that can be granted on this node.
 *
 * Code is the catalog, rows are the state — the same split features use. What a
 * business *can* hand out is a property of what this node can do, so it belongs
 * in the build; who actually holds it is a property of one business, so it
 * belongs in the database.
 *
 * Permissions are named `<area>:<action>` and read as sentences: a role holds
 * `submissions:read`, not `canReadSubmissions`. The area is usually a resource,
 * because that is the granularity a person is hired at — someone answers the
 * enquiries, someone else changes the website.
 *
 * A permission belonging to a feature disappears with it. Granting
 * `website:manage` on a node with no website is not a smaller grant, it is a
 * meaningless one, and offering it invites a role that quietly does nothing.
 */
export interface PermissionDefinition {
  key: string
  /** the group it is shown under */
  area: string
  name: string
  description: string
  /** only offered when this feature is on */
  feature?: string
  /**
   * Fields a condition may narrow this permission by. Empty means the grant is
   * all-or-nothing — there is nothing sensible to scope it to.
   */
  scopes?: Array<{ field: string; label: string }>
}

export const PERMISSION_CATALOG: Array<PermissionDefinition> = [
  {
    key: 'forms:read',
    area: 'Forms',
    name: 'See forms',
    description: 'View the forms this node serves and how they are built.',
    feature: 'forms',
  },
  {
    key: 'forms:write',
    area: 'Forms',
    name: 'Build forms',
    description: 'Create and change forms, their fields and their settings.',
    feature: 'forms',
  },
  {
    key: 'forms:delete',
    area: 'Forms',
    name: 'Delete forms',
    description: 'Remove a form. Its submissions go with it.',
    feature: 'forms',
  },
  {
    key: 'submissions:read',
    area: 'Submissions',
    name: 'Read submissions',
    description: 'Read what visitors have sent in.',
    feature: 'forms',
    // The reason this exists: answering one form's enquiries is a job, and it
    // is not the same job as reading every form's.
    scopes: [{ field: 'formId', label: 'Only these forms' }],
  },
  {
    key: 'submissions:write',
    area: 'Submissions',
    name: 'Handle submissions',
    description: 'Mark submissions as handled, and delete them.',
    feature: 'forms',
    scopes: [{ field: 'formId', label: 'Only these forms' }],
  },
  {
    key: 'submissions:delete',
    area: 'Submissions',
    name: 'Delete submissions',
    description:
      'Remove what a visitor sent. Separate from handling them because it is not the same act, and nothing that only files enquiries should be able to do it.',
    feature: 'forms',
    scopes: [{ field: 'formId', label: 'Only these forms' }],
  },
  {
    key: 'website:manage',
    area: 'Website',
    name: 'Manage the website',
    description:
      'Connect GitHub, create or adopt a repository, and publish the site.',
    feature: 'github-pages',
  },
  {
    key: 'content:read',
    area: 'Website',
    name: 'See site content',
    description: "Open the site's pages, symbols and settings.",
    feature: 'github-pages',
    /**
     * The three levels a rule about a site can name, from the repo's own CMS
     * configuration. A collection is what a designer sees in the sidebar; an
     * entry is one singleton or one page inside it; a field is one key of the
     * document. Left blank, the grant covers the whole site.
     */
    scopes: [
      { field: 'collection', label: 'Only these collections' },
      { field: 'file', label: 'Only these entries' },
      { field: 'field', label: 'Only these fields' },
    ],
  },
  {
    key: 'content:write',
    area: 'Website',
    name: 'Edit site content',
    description:
      'Change the site content and the page builder. Every save is a commit.',
    feature: 'github-pages',
    /**
     * The three levels a rule about a site can name, from the repo's own CMS
     * configuration. A collection is what a designer sees in the sidebar; an
     * entry is one singleton or one page inside it; a field is one key of the
     * document. Left blank, the grant covers the whole site.
     */
    scopes: [
      { field: 'collection', label: 'Only these collections' },
      { field: 'file', label: 'Only these entries' },
      { field: 'field', label: 'Only these fields' },
    ],
  },
  {
    key: 'config:write',
    area: 'Website',
    name: 'Change the dynamic configuration',
    description:
      'Edit the forms the site declares. Separate from the rest of the content because it changes what the node serves, not how a page looks.',
    feature: 'github-pages',
  },
  {
    key: 'settings:read',
    area: 'Node',
    name: 'See settings',
    description: "View this node's addresses and domain setup.",
  },
  {
    key: 'settings:write',
    area: 'Node',
    name: 'Change settings',
    description: 'Set the custom domain and verify its DNS.',
  },
  {
    key: 'features:manage',
    area: 'Node',
    name: 'Switch features on and off',
    description:
      'Decide what this node does at all. A switched-off feature takes its permissions with it.',
  },
  {
    key: 'infra:connect',
    area: 'Projects',
    name: 'Connect infrastructure accounts',
    description:
      'Link the Cloudflare and GitHub accounts new projects are built on. The account this grants over is the operator’s own, so this is effectively the keys to their hosting.',
    feature: 'projects',
  },
  {
    key: 'projects:read',
    area: 'Projects',
    name: 'See projects',
    description: 'View the projects this node has created.',
    feature: 'projects',
    scopes: [{ field: 'ownerUserId', label: 'Only their own' }],
  },
  {
    key: 'projects:create',
    area: 'Projects',
    name: 'Create a project',
    description:
      'Build a new, isolated project on the connected account. Each one is a database, a bucket and a Worker on their infrastructure.',
    feature: 'projects',
  },
  {
    key: 'projects:destroy',
    area: 'Projects',
    name: 'Destroy a project',
    description:
      'Remove a project and the infrastructure behind it. Its storage is deliberately kept, because it may hold somebody’s files.',
    feature: 'projects',
    scopes: [{ field: 'ownerUserId', label: 'Only their own' }],
  },
  {
    key: 'products:read',
    area: 'Shop',
    name: 'See what is for sale',
    description: 'View the catalogue, including drafts.',
    feature: 'payments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'products:write',
    area: 'Shop',
    name: 'Add and edit products',
    description:
      'Create listings, set prices and upload the file a buyer receives.',
    feature: 'payments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'products:delete',
    area: 'Shop',
    name: 'Delete a product',
    description:
      'Remove a listing. Its orders and downloads stay, because they are somebody’s receipt.',
    feature: 'payments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'orders:read',
    area: 'Money',
    name: 'See orders',
    description: 'View what has been bought and whether it was paid for.',
    feature: 'payments',
    scopes: [
      { field: 'buyerUserId', label: 'Only their own' },
      { field: 'status', label: 'Only these statuses' },
    ],
  },
  {
    key: 'orders:manage',
    area: 'Money',
    name: 'Refund and cancel',
    description:
      'Move money back. Separate from reading because reading the takings is a daily job and returning them is not.',
    feature: 'payments',
  },
  {
    key: 'payments:configure',
    area: 'Money',
    name: 'Set up the payment provider',
    description:
      'Enter the provider’s keys and read the webhook address. Effectively the keys to the money.',
    feature: 'payments',
  },
  {
    key: 'vendors:read',
    area: 'Vendors',
    name: 'See vendors',
    description: 'View the businesses selling on this node.',
    feature: 'vendors',
    scopes: [{ field: 'id', label: 'Only these vendors' }],
  },
  {
    key: 'vendors:write',
    area: 'Vendors',
    name: 'Edit a vendor',
    description:
      'Change a vendor’s name, description and contact address. Narrowed to their own, this is how a vendor edits their own storefront.',
    feature: 'vendors',
    scopes: [{ field: 'id', label: 'Only these vendors' }],
  },
  {
    key: 'payouts:withdraw',
    area: 'Vendors',
    name: 'Take money out',
    description:
      'Set up payouts and withdraw what is owed. Narrowed to their own vendor, this is what a vendor holds; reading a balance is separate from moving it.',
    feature: 'vendors',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'vendors:manage',
    area: 'Vendors',
    name: 'Add and remove vendors',
    description:
      'Create a vendor, suspend one, and decide who acts for it. The keys to the marketplace.',
    feature: 'vendors',
  },
  {
    key: 'services:read',
    area: 'Appointments',
    name: 'See what can be booked',
    description: 'View the bookable services, including drafts.',
    feature: 'appointments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'services:write',
    area: 'Appointments',
    name: 'Set up services and hours',
    description:
      'Create bookable services, set prices and durations, and say when you are available.',
    feature: 'appointments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'services:delete',
    area: 'Appointments',
    name: 'Delete a service',
    description:
      'Remove a service. Appointments already booked against it go with it, so this is the one to be careful with.',
    feature: 'appointments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'bookings:read',
    area: 'Appointments',
    name: 'See the diary',
    description: 'View appointments, who booked them and when they are.',
    feature: 'appointments',
    scopes: [
      { field: 'vendorId', label: 'Only these vendors' },
      { field: 'buyerUserId', label: 'Only their own' },
    ],
  },
  {
    key: 'bookings:manage',
    area: 'Appointments',
    name: 'Cancel appointments',
    description:
      'Call off an appointment and give the time back. Separate from reading the diary because looking at it is a daily job and cancelling somebody is not.',
    feature: 'appointments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'sales:read',
    area: 'Money',
    name: 'See sales lines',
    description:
      'View the individual lines of every order — what sold, for how much, and what the vendor was owed. Narrowed to their own, this is how a vendor sees their takings without seeing the marketplace’s.',
    feature: 'payments',
    scopes: [{ field: 'vendorId', label: 'Only these vendors' }],
  },
  {
    key: 'events:read',
    area: 'Instrumentation',
    name: 'Read the event log',
    description:
      'See what has happened on this node. Narrowable, so a vendor reads their own and nobody else’s.',
    feature: 'instrumentation',
    scopes: [
      { field: 'vendorId', label: 'Only these vendors' },
      { field: 'name', label: 'Only these events' },
    ],
  },
  {
    key: 'team:read',
    area: 'Team',
    name: 'See the team',
    description: 'View who has access and what they can do.',
    feature: 'user-management',
  },
  {
    key: 'team:manage',
    area: 'Team',
    name: 'Manage the team',
    description:
      'Invite people, change what a role can do, and remove access. Effectively the keys to the node.',
    feature: 'user-management',
  },
]

/** Grouped for display, in catalog order, with nothing the node cannot do. */
export function permissionsFor(
  enabledFeatures: Array<string>,
): Array<PermissionDefinition> {
  return PERMISSION_CATALOG.filter(
    (permission) =>
      !permission.feature || enabledFeatures.includes(permission.feature),
  )
}

export function permissionKeys(enabledFeatures: Array<string>): Array<string> {
  return permissionsFor(enabledFeatures).map((permission) => permission.key)
}

export function definitionOf(key: string): PermissionDefinition | undefined {
  return PERMISSION_CATALOG.find((permission) => permission.key === key)
}

/**
 * Which permission a REST call needs.
 *
 * Kept here rather than scattered through the routes: a table of who-may-do-what
 * is the sort of thing that has to be readable in one sitting to be trusted.
 */
export const RESOURCE_PERMISSIONS: Record<
  string,
  { read: string; write: string; delete?: string }
> = {
  forms: { read: 'forms:read', write: 'forms:write', delete: 'forms:delete' },
  submissions: {
    read: 'submissions:read',
    write: 'submissions:write',
    // Its own permission. Marking an enquiry handled and destroying it are
    // different decisions, and a role that does the first every day should not
    // carry the second by accident.
    delete: 'submissions:delete',
  },
  // Deciding who gets told is a submissions job, not a settings one — it is
  // the same person who reads them.
  automations: {
    read: 'submissions:read',
    write: 'submissions:write',
    delete: 'submissions:write',
  },
  notifications: { read: 'submissions:read', write: 'submissions:write' },
  features: { read: 'settings:read', write: 'features:manage' },
  roles: { read: 'team:read', write: 'team:manage', delete: 'team:manage' },
  // Writing a policy is writing the rule a role is built from, so it needs
  // exactly what changing a role needs — anything less would be a way around it.
  policies: { read: 'team:read', write: 'team:manage', delete: 'team:manage' },
  invitations: { read: 'team:read', write: 'team:manage', delete: 'team:manage' },
  // Append-only. `write` names a permission that is deliberately not in the
  // catalog, so no role can hold it — but `readOnly` below is what actually
  // refuses, and it does so without depending on that.
  events: { read: 'events:read', write: 'events:append' },
  // Written by checkout and moved by webhooks; never posted to directly.
  orders: { read: 'orders:read', write: 'orders:manage' },
  projects: {
    read: 'projects:read',
    write: 'projects:create',
    delete: 'projects:destroy',
  },
  products: {
    read: 'products:read',
    write: 'products:write',
    delete: 'products:delete',
  },
  vendors: {
    read: 'vendors:read',
    write: 'vendors:write',
    delete: 'vendors:manage',
  },
  services: {
    read: 'services:read',
    write: 'services:write',
    delete: 'services:delete',
  },
  // The hours behind a service, not a thing of its own — whoever sets up what
  // can be booked sets up when.
  availability: {
    read: 'services:read',
    write: 'services:write',
    delete: 'services:write',
  },
  // Read-only over REST. An appointment written here would skip the slot
  // check and the constraint that stops two people sharing a Thursday, so the
  // only ways in are `/api/book/hold` and the cancel route.
  bookings: { read: 'bookings:read', write: 'bookings:manage' },
  // Order lines, which is where `vendorId` lives — an order can have several
  // vendors on it, so "a vendor's sales" is a question about lines.
  sales: { read: 'sales:read', write: 'orders:manage' },
}
