/**
 * DNS checks over DNS-over-HTTPS.
 *
 * A Worker has no resolver, so lookups go to 1.1.1.1's JSON API. That also
 * means we see public DNS rather than a local cache, which is what we want:
 * the question is whether the *world* can resolve the record, not whether this
 * machine can.
 */

export type RecordType = 'A' | 'CNAME'

interface DohAnswer {
  name: string
  type: number
  data: string
}

const TYPE_NUMBERS: Record<RecordType, number> = { A: 1, CNAME: 5 }

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
