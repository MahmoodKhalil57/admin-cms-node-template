import type { DnsRequirement } from './dns'
import { frontendRequirement, isApex } from './dns'

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

  /** GitHub account publishing the site, if one is connected */
  githubOwner?: string | null
}

/**
 * Where the API answers: `api.` in front of the operator's own domain.
 *
 * A CNAME only says "ask that host instead" — it does not hand over the right
 * to serve a name. Whoever answers still needs a certificate for the name in
 * the address bar, which is why pointing the record is only half the job: the
 * platform also registers the hostname so a certificate is issued for it.
 * Depth is irrelevant once certificates are per-hostname.
 */
export const API_PREFIX = 'api'

/**
 * Certificate authorities the platform's certificates are issued by.
 *
 * These have to be permitted at the API hostname, and the reason is not
 * obvious. CAA is evaluated at the name being certified and then, if it has no
 * records, at each parent in turn. The parent here is the operator's own
 * domain — which points at GitHub Pages, and a CAA lookup on a CNAME follows it
 * to `github.io`, whose policy allows only GitHub's authorities. So a domain
 * that is perfectly configured for the website silently blocks the certificate
 * for `api.` on it.
 *
 * A CAA record on the API hostname itself stops the climb before it reaches
 * that policy.
 */
export const CERTIFICATE_AUTHORITIES = [
  'ssl.com',
  'letsencrypt.org',
  'pki.goog',
  'digicert.com',
]

export function apiHostname(root: string): string {
  return `${API_PREFIX}.${root}`
}

export function planDomain(input: PlanInput): Array<DomainPurpose> {
  const { root, githubOwner } = input

  return [
    {
      key: 'frontend',
      label: 'Website',
      description: `Serves your site at ${root}${
        isApex(root) ? '' : ' (a subdomain, so a CNAME rather than A records)'
      }`,
      hostname: root,
      // GitHub Pages wants four A records on an apex but a CNAME on a
      // subdomain, and getting that wrong leaves the site unreachable with
      // records that look plausible.
      requirement: githubOwner ? frontendRequirement(root, githubOwner) : null,
      blocked: githubOwner
        ? undefined
        : 'Connect GitHub and publish a site first.',
    },
    {
      key: 'api',
      label: 'API',
      description: `Receives form submissions at https://${root}/api — the same hostname as your site, so there is no second record to add`,
      hostname: root,
      // Nothing extra for the operator: the API rides on the record they
      // already added for the website.
      requirement: null,
    },
  ]
}
