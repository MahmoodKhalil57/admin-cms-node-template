/**
 * DNS checks over DNS-over-HTTPS.
 *
 * A Worker has no resolver, so lookups go to 1.1.1.1's JSON API. That also
 * means we see public DNS rather than a local cache, which is what we want:
 * the question is whether the *world* can resolve the record, not whether this
 * machine can.
 */

export type RecordType = 'A' | 'CNAME' | 'NS' | 'CAA'

interface DohAnswer {
  name: string
  type: number
  data: string
}

const TYPE_NUMBERS: Record<RecordType, number> = { A: 1, CNAME: 5, NS: 2, CAA: 257 }

async function query(name: string, type: RecordType): Promise<Array<string>> {
  const url = new URL('https://cloudflare-dns.com/dns-query')
  url.searchParams.set('name', name)
  url.searchParams.set('type', type)

  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
  })
  if (!response.ok) return []

  const body = (await response.json()) as { Answer?: Array<DohAnswer> }
  return (body.Answer ?? [])
    .filter((answer) => answer.type === TYPE_NUMBERS[type])
    .map((answer) => answer.data.replace(/\.$/, '').toLowerCase())
}

export interface DnsRequirement {
  type: RecordType
  /** the name the record goes on, as the user would type it */
  name: string
  /** every acceptable value; any one of them satisfies the check */
  expected: Array<string>
}

export interface DnsCheck {
  ok: boolean
  type: RecordType
  name: string
  expected: Array<string>
  found: Array<string>
  message: string
}

/** GitHub's apex addresses for Pages. */
export const GITHUB_PAGES_IPS = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
]

export function isApex(domain: string): boolean {
  // Good enough for the common cases: anything with more than two labels is
  // treated as a subdomain. Multi-part public suffixes like `co.uk` would need
  // the public suffix list, which is more than this check is worth.
  return domain.split('.').filter(Boolean).length <= 2
}

/** What the frontend domain needs, which differs for an apex. */
export function frontendRequirement(
  domain: string,
  owner: string,
): DnsRequirement {
  return isApex(domain)
    ? { type: 'A', name: domain, expected: GITHUB_PAGES_IPS }
    : { type: 'CNAME', name: domain, expected: [`${owner.toLowerCase()}.github.io`] }
}

/**
 * What the API domain needs.
 *
 * An apex cannot hold a CNAME, so it needs a provider that flattens one —
 * which in practice means the domain is on Cloudflare, and a subdomain is the
 * simpler advice.
 */
export function apiRequirement(domain: string, target: string): DnsRequirement {
  return { type: 'CNAME', name: domain, expected: [target.toLowerCase()] }
}

export async function checkRecord(
  requirement: DnsRequirement,
): Promise<DnsCheck> {
  let found: Array<string> = []
  try {
    found = await query(requirement.name, requirement.type)
  } catch {
    return {
      ok: false,
      ...requirement,
      found: [],
      message: 'Could not reach DNS to check.',
    }
  }

  const expected = requirement.expected.map((value) => value.toLowerCase())

  if (found.length === 0) {
    return {
      ok: false,
      ...requirement,
      found,
      message: `No ${requirement.type} record found for ${requirement.name}. New records can take a few minutes to appear.`,
    }
  }

  // For A records every expected address should be present; for a CNAME any
  // one match is enough.
  const ok =
    requirement.type === 'A'
      ? expected.every((value) => found.includes(value))
      : requirement.type === 'CAA'
        ? // Any one authority being permitted is enough; the record's job is to
          // stop the lookup climbing to a parent that forbids ours.
          expected.some((value) =>
            found.some((entry) => entry.includes(value)),
          )
        : found.some((value) => expected.includes(value))

  return {
    ok,
    ...requirement,
    found,
    message: ok
      ? 'Pointing to the right place.'
      : `Points to ${found.join(', ')} instead of ${expected.join(' / ')}.`,
  }
}

/**
 * Whether a domain is served by Cloudflare, and which zone it sits in.
 *
 * Walks up the labels, because NS records live at the zone apex and nowhere
 * else — asking `www.example.com` returns nothing even when `example.com` is on
 * Cloudflare, which would silently deny the operator the automatic setup. The
 * label where the NS records turn up *is* the zone, which is worth returning:
 * it is what a link into the Cloudflare dashboard needs, and working it out
 * from the string alone is the problem the public suffix list exists for.
 */
export async function detectCloudflare(
  domain: string,
): Promise<{ onCloudflare: boolean; zone: string | null }> {
  const labels = domain.split('.').filter(Boolean)

  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.')
    try {
      const nameservers = await query(candidate, 'NS')
      if (nameservers.length > 0) {
        return {
          onCloudflare: nameservers.some((ns) => ns.endsWith('.ns.cloudflare.com')),
          zone: candidate,
        }
      }
    } catch {
      return { onCloudflare: false, zone: null }
    }
  }

  return { onCloudflare: false, zone: null }
}

/**
 * Whether a hostname actually reaches this node.
 *
 * Asks the node itself rather than inspecting DNS, because a proxied record
 * resolves to the proxy and tells you nothing about what is behind it — and
 * because "does it serve" is what the operator actually wants to know. A
 * certificate that has not been issued yet fails here too, which is correct:
 * the address does not work until it does.
 */
export async function servesNode(
  hostname: string,
  expectedNodeId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`https://${hostname}/api/health`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return { ok: false, message: `Answered ${response.status}, not this node.` }
    }
    const body = (await response.json()) as { node?: string }
    return body.node === expectedNodeId
      ? { ok: true, message: 'Serving this node.' }
      : {
          ok: false,
          message: `Reached a different node (${body.node ?? 'unknown'}).`,
        }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // A TLS failure here is usually a certificate that does not exist yet,
    // which is what happens when the hostname sits more than one label below
    // the zone apex and only a wildcard certificate covers it.
    return {
      ok: false,
      message: `Could not reach it yet (${detail}). A new hostname can take a few minutes, and needs a certificate that covers it.`,
    }
  }
}
