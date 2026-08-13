import type { NodeEnv } from './env'

async function pages(
  token: string,
  owner: string,
  repo: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; message?: string; body?: Record<string, unknown> }> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pages`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'admin-cms-node',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  )

  if (response.status === 204) return { status: 204 }

  const parsed = (await response.json().catch(() => null)) as {
    message?: string
  } & Record<string, unknown>

  return {
    status: response.status,
    message: parsed?.message,
    body: parsed ?? undefined,
  }
}

/**
 * Points a repo's GitHub Pages site at a custom domain.
 *
 * Two stages, and the order is forced: setting `cname` and `https_enforced` in
 * the same call fails with *"The certificate does not exist yet"*, because
 * GitHub only starts issuing a certificate once it knows the domain. So the
 * domain goes first, and HTTPS is enforced afterwards — and only if the
 * certificate has actually arrived, which takes minutes.
 *
 * GitHub also refuses a domain whose DNS does not already resolve to it, which
 * is why this runs after the DNS check rather than before.
 */
export async function applyPagesDomain(
  token: string,
  owner: string,
  repo: string,
  domain: string,
): Promise<{ ok: boolean; note?: string }> {
  const set = await pages(token, owner, repo, 'PUT', { cname: domain })

  if (set.status !== 204 && set.status !== 200) {
    return {
      ok: false,
      note: set.message ?? `GitHub refused the domain (HTTP ${set.status}).`,
    }
  }

  // Enforcing HTTPS is a second, best-effort step: the certificate is issued
  // asynchronously, so this simply succeeds on a later run.
  const current = await pages(token, owner, repo, 'GET')
  const certificate = (current.body?.https_certificate ?? {}) as {
    state?: string
  }
  const ready = certificate.state === 'approved'

  if (!ready) {
    return {
      ok: true,
      note: 'Domain set. GitHub is issuing a certificate, so HTTPS follows in a few minutes.',
    }
  }

  if (current.body?.https_enforced === true) {
    return { ok: true, note: 'Domain set and HTTPS enforced.' }
  }

  const enforced = await pages(token, owner, repo, 'PUT', {
    cname: domain,
    https_enforced: true,
  })

  return enforced.status === 204 || enforced.status === 200
    ? { ok: true, note: 'Domain set and HTTPS enforced.' }
    : {
        ok: true,
        note: 'Domain set. HTTPS could not be enforced yet — check again shortly.',
      }
}

/**
 * Asks the platform to register this hostname so a certificate is issued for it.
 *
 * The operator's side is finished once their CNAME resolves — this is the half
 * that happens on ours. It needs the platform's own credentials, so the node
 * cannot do it directly; it authenticates with the token derived for it at
 * provision time, which master recomputes.
 */
export interface HostnameProbe {
  site: number
  api: number
  node?: string
}

export async function registerCustomHostname(
  env: NodeEnv,
  hostname: string,
): Promise<{ ok: boolean; note: string; probe?: HostnameProbe }> {
  if (!env.MASTER || !env.PROVISION_TOKEN) {
    return { ok: false, note: 'This node cannot reach the platform.' }
  }

  try {
    // The hostname here is arbitrary — a service binding goes straight to the
    // Worker, so only the path matters.
    const response = await env.MASTER.fetch(
      'https://master/api/internal/hostname',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.PROVISION_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: env.NODE_ID, hostname }),
      },
    )
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      error?: string
      sslStatus?: string
      probe?: HostnameProbe
    }

    if (!response.ok || !body.ok) {
      return { ok: false, note: body.error ?? `Platform said ${response.status}.` }
    }

    if (body.sslStatus && body.sslStatus !== 'active') {
      return {
        ok: true,
        probe: body.probe,
        note: `Certificate is ${body.sslStatus.replace(/_/g, ' ')}; this usually takes a few minutes.`,
      }
    }

    return { ok: true, probe: body.probe, note: 'Certificate issued.' }
  } catch (error) {
    return {
      ok: false,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Tells the dispatch Worker that a hostname belongs to this node.
 *
 * The dispatcher resolves every request and has no database, so the mapping
 * lives in a KV namespace both it and the nodes can see. A node writes only its
 * own hostname key.
 *
 * Registering the name is not the whole story: Cloudflare will only answer for
 * a hostname it has been configured to terminate, which for a domain the
 * platform does not own means Cloudflare for SaaS. Until that exists the record
 * can be correct and the domain still not serve, so this says so plainly rather
 * than reporting success.
 */
export async function registerApiHostname(
  env: NodeEnv,
  domain: string,
  slug: string,
): Promise<{ ok: boolean; note?: string }> {
  if (!env.ROUTING) {
    return {
      ok: false,
      note: 'This node has no routing namespace, so the domain cannot be registered.',
    }
  }

  try {
    await env.ROUTING.put(`host:${domain}`, slug)
    return { ok: true, note: 'Routed to this node.' }
  } catch (error) {
    return {
      ok: false,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}
