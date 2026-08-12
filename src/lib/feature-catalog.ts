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
}

export const FEATURE_CATALOG: Array<FeatureDefinition> = [
  {
    key: 'forms',
    name: 'Forms',
    description:
      'Build forms and collect submissions, including from a public website.',
    defaultEnabled: true,
  },
  {
    key: 'github-pages',
    name: 'GitHub Pages frontend',
    description:
      'Connect GitHub and publish a static website that posts to this node. ' +
      'Create one from the starter template, or adopt a repository you already have.',
    defaultEnabled: false,
  },
]

export function featureDefinition(key: string): FeatureDefinition | undefined {
  return FEATURE_CATALOG.find((feature) => feature.key === key)
}
