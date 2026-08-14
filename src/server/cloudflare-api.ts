import type { DnsRequirement } from './dns'

const API = 'https://api.cloudflare.com/client/v4'

export class CloudflareApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'CloudflareApiError'
    this.status = status
  }
}

interface CfResult<T> {
  status: number
  ok: boolean
  result?: T
  errors?: Array<{ code: number; message: string }>
}

async function cf<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<CfResult<T>> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = (await response.json().catch(() => ({}))) as {
    result?: T
    errors?: Array<{ code: number; message: string }>
  }
  return {
    status: response.status,
    ok: response.ok,
    result: body.result,
    errors: body.errors,
  }
}

function describe(res: CfResult<unknown>): string {
  return res.errors?.length
    ? res.errors.map((error) => error.message).join('; ')
    : `HTTP ${res.status}`
}

export interface Zone {
  id: string
  name: string
}

/**
 * Finds the zone a hostname belongs to.
 *
 * Walks up the labels because the granted account may hold `example.com` while
 * the operator typed a subdomain of it — and because guessing the registrable
 * domain from a string is exactly the problem the public suffix list exists for.
 */
export async function findZone(
  token: string,
  domain: string,
): Promise<Zone | null> {
  const labels = domain.split('.')

  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.')
    const res = await cf<Array<Zone>>(
      token,
      `/zones?name=${encodeURIComponent(candidate)}&status=active`,
    )
    if (!res.ok) throw new CloudflareApiError(describe(res), res.status)
    const zone = res.result?.find((entry) => entry.name === candidate)
    if (zone) return zone
  }

  return null
}

interface DnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
}

export interface AppliedRecord {
  name: string
  type: string
  content: string
  action: 'created' | 'updated' | 'unchanged'
}

/**
 * Writes the records a requirement asks for, replacing whatever is there.
 *
 * Records are created **proxied**, and the reason is the panel and the API.
 * Only `/admin*` and `/api*` are handed to the node by Worker routes, and a
 * Worker route can only fire on traffic that reaches Cloudflare's edge — a
 * grey-cloud record goes straight to GitHub Pages and never gets there. So an
 * unproxied record gives a working website and a panel that cannot be reached,
 * which is the harder of the two failures to attribute.
 *
 * These were written unproxied on the theory that proxying breaks GitHub Pages'
 * certificate. It does not: Cloudflare terminates TLS with its own certificate
 * for the hostname and fetches from Pages behind it, which is how the node that
 * has worked all along has been configured the entire time.
 */
export async function applyRequirement(
  token: string,
  zone: Zone,
  requirement: DnsRequirement,
): Promise<Array<AppliedRecord>> {
  const existing = await cf<Array<DnsRecord>>(
    token,
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(requirement.name)}&type=${requirement.type}&per_page=100`,
  )
  if (!existing.ok) throw new CloudflareApiError(describe(existing), existing.status)

  const current = existing.result ?? []
  const wanted = requirement.expected
  const applied: Array<AppliedRecord> = []

  // Anything present that we do not want any more has to go, or an old A record
  // pointing somewhere else would keep answering alongside the new ones.
  const stale = current.filter((record) => !wanted.includes(record.content))
  const keep = current.filter((record) => wanted.includes(record.content))

  for (const record of stale) {
    const deleted = await cf(token, `/zones/${zone.id}/dns_records/${record.id}`, {
      method: 'DELETE',
    })
    if (!deleted.ok) throw new CloudflareApiError(describe(deleted), deleted.status)
  }

  for (const value of wanted) {
    const already = keep.find((record) => record.content === value)

    if (already && already.proxied === true) {
      applied.push({
        name: requirement.name,
        type: requirement.type,
        content: value,
        action: 'unchanged',
      })
      continue
    }

    if (already) {
      const updated = await cf(token, `/zones/${zone.id}/dns_records/${already.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ proxied: true }),
      })
      if (!updated.ok) throw new CloudflareApiError(describe(updated), updated.status)
      applied.push({
        name: requirement.name,
        type: requirement.type,
        content: value,
        action: 'updated',
      })
      continue
    }

    const created = await cf(token, `/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: requirement.type,
        name: requirement.name,
        content: value,
        ttl: 1,
        proxied: true,
      }),
    })
    if (!created.ok) throw new CloudflareApiError(describe(created), created.status)
    applied.push({
      name: requirement.name,
      type: requirement.type,
      content: value,
      action: 'created',
    })
  }

  return applied
}

/**
 * Points a hostname at the dispatch Worker.
 *
 * A CNAME to `*.workers.dev` cannot work — Cloudflare only answers for a
 * hostname it has been told to terminate. What does work is the pair Cloudflare
 * itself uses: a **proxied** placeholder record so traffic reaches the edge, and
 * a Worker route so the edge hands it to the script. `100::` is the IPv6
 * discard prefix, so the record never resolves to anything real; only the proxy
 * matters.
 *
 * Requires the zone and the Worker to be on the same account. Across accounts
 * this is what Cloudflare for SaaS exists for.
 */
export async function bindHostnameToWorker(
  token: string,
  zone: Zone,
  hostname: string,
  script: string,
): Promise<{ ok: boolean; note: string }> {
  const existing = await cf<Array<DnsRecord>>(
    token,
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
  )
  if (!existing.ok) return { ok: false, note: describe(existing) }

  // Anything already on the name would compete with the placeholder.
  for (const record of existing.result ?? []) {
    if (record.type === 'AAAA' && record.content === '100::' && record.proxied) continue
    await cf(token, `/zones/${zone.id}/dns_records/${record.id}`, { method: 'DELETE' })
  }

  const hasPlaceholder = (existing.result ?? []).some(
    (record) => record.type === 'AAAA' && record.content === '100::' && record.proxied,
  )

  if (!hasPlaceholder) {
    const created = await cf(token, `/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'AAAA',
        name: hostname,
        content: '100::',
        proxied: true,
        ttl: 1,
        comment: 'Routes to your adminCms node',
      }),
    })
    if (!created.ok) return { ok: false, note: describe(created) }
  }

  const routes = await cf<Array<{ id: string; pattern: string }>>(
    token,
    `/zones/${zone.id}/workers/routes`,
  )
  /*
    The connection may not be allowed to touch routes.

    Cloudflare validates requested scopes against the OAuth app's registration
    and refuses the whole authorization if one is missing, so this node asks
    only for DNS — which means the route that puts the API on the operator's own
    hostname is theirs to add. Said as an instruction rather than an error,
    because everything else about the connection worked and the DNS records,
    which are the larger and more error-prone half, are already done.
  */
  if (routes.status === 403 || routes.status === 401) {
    return {
      ok: false,
      note:
        `This Cloudflare connection can manage DNS but not Worker routes. ` +
        `Add one by hand in Cloudflare under Workers Routes: pattern ` +
        `${hostname}/*, worker ${script}. Everything else is set up.`,
    }
  }
  if (!routes.ok) return { ok: false, note: describe(routes) }

  const pattern = `${hostname}/*`
  if ((routes.result ?? []).some((route) => route.pattern === pattern)) {
    return { ok: true, note: 'Already routed to the node.' }
  }

  const route = await cf(token, `/zones/${zone.id}/workers/routes`, {
    method: 'POST',
    body: JSON.stringify({ pattern, script }),
  })
  if (!route.ok) return { ok: false, note: describe(route) }

  return { ok: true, note: 'Routed to the node.' }
}
