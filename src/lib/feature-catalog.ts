/**
 * Every feature this build of the node knows how to run.
 *
 * The catalog is code, not data: a feature exists because there is code for it,
 * so shipping a new build is what makes it available. The node's `features`
 * table only records which of these are switched *on*.
 *
 * Keeping the two separate is what makes upgrades work — a build that adds a
 * feature will not have a row for it in an existing node's database, and the
 * catalog is what lets it show up (switched off) rather than silently vanish.
 *
 * Dependency-free on purpose: imported by both the admin UI and the server.
 */
export interface FeatureDefinition {
  key: string
  name: string
  description: string
  /** whether a freshly provisioned node starts with this on */
  defaultEnabled: boolean
  /**
   * Not a feature so much as part of what a node is.
   *
   * A node exists to be the back end of a website, to take money, and to know
   * who is allowed to do what — and a node with any of those switched off is
   * not a smaller node, it is a broken one. Switching them off was never a
   * capability anybody wanted; it was a consequence of the catalog treating
   * every feature the same way.
   *
   * These cannot be turned off, and the screen says so rather than offering a
   * toggle that refuses.
   */
  alwaysOn?: boolean
  /**
   * Admin resources this feature brings with it.
   *
   * Declared here so the sidebar can group them under the feature that owns
   * them — they appear and disappear together, and a flat list hides that.
   */
  resources?: Array<string>
}

export const FEATURE_CATALOG: Array<FeatureDefinition> = [
  {
    key: 'forms',
    name: 'Forms',
    description:
      'Build forms and collect submissions, including from a public website.',
    defaultEnabled: true,
    resources: ['forms', 'submissions', 'automations', 'notifications'],
  },
  {
    key: 'user-management',
    alwaysOn: true,
    name: 'Team and permissions',
    description:
      'Invite the rest of the team and decide what each of them can reach. ' +
      'Roles are yours to define — the node only says what can be granted, not who should have it.',
    defaultEnabled: true,
    resources: ['team', 'roles', 'invitations'],
  },
  {
    key: 'projects',
    name: 'Projects',
    description:
      'Lets this node create projects on its operator’s own Cloudflare and GitHub. What is built that way costs us nothing and uses none of our keys.',
    defaultEnabled: false,
  },
  {
    key: 'payments',
    alwaysOn: true,
    name: 'Payments',
    description:
      'Take money. rootAdmin chooses a provider, pastes their own keys, and adds the webhook in the provider’s console.',
    defaultEnabled: true,
  },
  {
    key: 'vendors',
    name: 'Multiple vendors',
    description:
      'Lets more than one business sell here, each seeing only their own rows. Off means this node is one shop.',
    defaultEnabled: false,
  },
  {
    key: 'appointments',
    name: 'Appointments',
    description:
      'Sell time rather than things. Set when you are available, and people book and pay for a slot. With multiple vendors on, each keeps their own diary.',
    defaultEnabled: false,
    resources: ['services', 'availability', 'bookings'],
  },
  {
    key: 'instrumentation',
    name: 'Logs and analytics',
    description:
      'What has happened on this node, and who may see it. Always recorded; this decides who can read it.',
    // Off until somebody wants the screens. The log fills up either way, which
    // is the whole point — switching this on later shows history, not a blank.
    defaultEnabled: false,
  },
  {
    key: 'github-pages',
    alwaysOn: true,
    name: 'GitHub Pages frontend',
    description:
      'Connect GitHub and publish a static website that posts to this node. ' +
      'Create one from the starter template, or adopt a repository you already have.',
    defaultEnabled: true,
  },
]

/**
 * Note on this one: the flag decides who may *read* the event log, never
 * whether it is written. A node that recorded nothing until somebody switched
 * instrumentation on would have nothing to show them at the moment they asked
 * — which is the one failure this whole feature exists to avoid.
 */
/** The ones that cannot be switched off. */
export const ALWAYS_ON = FEATURE_CATALOG.filter(
  (feature) => feature.alwaysOn,
).map((feature) => feature.key)

export function featureDefinition(key: string): FeatureDefinition | undefined {
  return FEATURE_CATALOG.find((feature) => feature.key === key)
}
