import type { DnsRequirement } from './dns'
import { GITHUB_PAGES_IPS } from './dns'

/**
 * What one custom domain is used for.
 *
 * A node takes a single domain and derives every hostname it needs from it, so
 * the operator sets `example.com` once instead of maintaining a list that has
 * to stay consistent. Adding a use — email is the obvious next one — means
 * adding an entry here and nothing else: the settings screen, the DNS checks
 * and the stored verification state are all driven off this plan.
 */
export type PurposeKey = 'frontend' | 'api'

export interface DomainPurpose {
  key: PurposeKey
  label: string
  description: string
  /** the hostname this use answers on */
  hostname: string
  /** null when it cannot be set up yet, with `blocked` saying why */
  requirement: DnsRequirement | null
  blocked?: string
}

export interface PlanInput {
  /** the registrable domain the operator entered, e.g. `example.com` */
  root: string
  /** hostname every node is reached through */
  dispatcherHost: string
  /** GitHub account publishing the site, if one is connected */
  githubOwner?: string | null
}

/**
 * The API lives on a subdomain rather than the apex.
 *
 * An apex cannot hold a CNAME, and the website wants the apex anyway — so
 * putting the API on `api.` avoids a collision and a DNS limitation at once.
 */
export const API_PREFIX = 'api'

export function apiHostname(root: string): string {
  return `${API_PREFIX}.${root}`
}

export function planDomain(input: PlanInput): Array<DomainPurpose> {
  const { root, dispatcherHost, githubOwner } = input

  return [
    {
      key: 'frontend',
      label: 'Website',
      description: `Serves your site at ${root}`,
      hostname: root,
      requirement: githubOwner
        ? { type: 'A', name: root, expected: GITHUB_PAGES_IPS }
        : null,
      blocked: githubOwner
        ? undefined
        : 'Connect GitHub and publish a site first.',
    },
    {
      key: 'api',
      label: 'API',
      description: `Receives form submissions at ${apiHostname(root)}`,
      hostname: apiHostname(root),
      requirement: dispatcherHost
        ? {
            type: 'CNAME',
            name: apiHostname(root),
            expected: [dispatcherHost.toLowerCase()],
          }
        : null,
      blocked: dispatcherHost ? undefined : 'This node does not know its router.',
    },
  ]
}
