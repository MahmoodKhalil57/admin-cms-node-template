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
}
