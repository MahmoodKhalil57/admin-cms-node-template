import type { NodeEnv } from './env'

/**
 * Points a repo's GitHub Pages site at a custom domain.
 *
 * GitHub refuses a domain whose DNS does not already resolve to it, which is
 * why this only runs after the check passes. It also writes a CNAME file into
 * the repo itself — that file is what survives a rebuild, and GitHub treats it
 * as the source of truth.
 */
export async function applyPagesDomain(
  token: string,
  owner: string,
  repo: string,
  domain: string,
): Promise<{ ok: boolean; note?: string }> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pages`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'admin-cms-node',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cname: domain, https_enforced: true }),
    },
  )

  if (response.status === 204 || response.status === 200) {
    return {
      ok: true,
      note: 'GitHub is issuing a certificate; HTTPS can take a few minutes.',
    }
  }

  const body = (await response.json().catch(() => null)) as {
    message?: string
  } | null

  return {
    ok: false,
    note: body?.message ?? `GitHub refused the domain (HTTP ${response.status}).`,
  }
}

/**
 * Tells the dispatch Worker that a hostname belongs to this node.
 *
 * The dispatcher resolves every request, and it has no database — so the
 * mapping lives in a KV namespace both it and the nodes can see. A node writes
 * only its own hostname key.
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
    return {
      ok: true,
      note:
        'Registered with the router. Cloudflare must also be set up to terminate this hostname ' +
        'before it will serve — see the note below.',
    }
  } catch (error) {
    return {
      ok: false,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}
