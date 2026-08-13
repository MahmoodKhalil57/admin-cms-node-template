import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { forms } from '#/db/schema'

export class SiteError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'SiteError'
    this.status = status
  }
}

interface GhResponse {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
}

async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GhResponse> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'admin-cms-node',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await response.json().catch(() => null)
  return { status: response.status, json }
}

/** The example form a new site posts to, created if the node has none. */
export const EXAMPLE_FORM_SLUG = 'early-access'

export async function ensureExampleForm(db: NodeDb): Promise<string> {
  const [existing] = await db
    .select()
    .from(forms)
    .where(eq(forms.slug, EXAMPLE_FORM_SLUG))
    .limit(1)

  if (existing) {
    // A draft form would 404 for the public page, which would look like the
    // site is broken rather than unpublished.
    if (existing.status !== 'published') {
      await db
        .update(forms)
        .set({ status: 'published' })
        .where(eq(forms.id, existing.id))
    }
    return EXAMPLE_FORM_SLUG
  }

  await db.insert(forms).values({
    name: 'Early access',
    slug: EXAMPLE_FORM_SLUG,
    status: 'published',
    successMessage: 'You are on the list.',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
    ],
  })

  return EXAMPLE_FORM_SLUG
}

/**
 * Rewrites a file, read-modify-write with the blob's sha.
 *
 * Carrying the sha is what makes this safe to re-run: GitHub rejects the write
 * if the file moved under us, rather than silently clobbering someone's edit.
 */
async function patchFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  transform: (current: string) => string,
  message: string,
): Promise<void> {
  const current = await gh(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`)
  if (current.status !== 200) {
    throw new SiteError(
      `Could not read ${path} from ${owner}/${repo}.`,
      current.status,
    )
  }

  const decoded = atob(String(current.json.content).replace(/\n/g, ''))
  const contents = transform(
    new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0))),
  )
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(contents)))
  const put = await gh(token, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, {
    message,
    content: encoded,
    sha: current.json.sha,
  })

  if (put.status !== 200 && put.status !== 201) {
    throw new SiteError(
      `Could not write ${path}: ${put.json?.message ?? `HTTP ${put.status}`}`,
      put.status,
    )
  }
}

/**
 * Points the template's own config at this node.
 *
 * The template keeps its settings in `content/site.json`, which its editors
 * also write — so this merges rather than overwrites. Clobbering the file would
 * throw away whatever the operator had edited in the CMS.
 */
function withBackend(
  current: string,
  backendUrl: string,
  formSlug: string,
): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(current) as Record<string, unknown>
  } catch {
    parsed = {}
  }

  parsed.backend = { url: backendUrl, form: formSlug }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export interface SiteSetupOptions {
  token: string
  /** `owner/repo` of the template new sites are generated from */
  templateRepo: string
  /** repo name to create, when creating */
  name: string
  /** the node's own public URL, which the site will post to */
  backendUrl: string
  formSlug: string
}

export interface SiteResult {
  owner: string
  repo: string
  pagesUrl: string
  repoUrl: string
  created: boolean
}

async function whoami(token: string): Promise<string> {
  const who = await gh(token, 'GET', '/user')
  if (who.status !== 200 || !who.json?.login) {
    throw new SiteError('The GitHub token does not work.', who.status)
  }
  return who.json.login as string
}

/**
 * Turns a repo into a published site: point it at this node, then enable Pages.
 *
 * Split out because creating and connecting converge here — the only difference
 * is whether the repo already existed.
 */
async function configureAndPublish(
  options: SiteSetupOptions,
  owner: string,
  repo: string,
  created: boolean,
): Promise<SiteResult> {
  const pagesUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`

  await patchFile(
    options.token,
    owner,
    repo,
    'content/site.json',
    (current) => withBackend(current, options.backendUrl, options.formSlug),
    'Point this site at its adminCms node',
  )

  // The CMS commits straight back to this repo, so it has to know which one it
  // is — the template ships pointing at wherever it was authored.
  await patchFile(
    options.token,
    owner,
    repo,
    'static-admin/config.yml',
    (current) =>
      current
        .replace(/^(\s*repo:\s*).*$/m, `$1${owner}/${repo}`)
        .replace(/^(site_url:\s*).*$/m, `$1${pagesUrl}`)
        .replace(/^(display_url:\s*).*$/m, `$1${pagesUrl}`),
    'Point the CMS at this repo',
  )

  const branch = await gh(options.token, 'GET', `/repos/${owner}/${repo}`)
  const defaultBranch = (branch.json?.default_branch as string) ?? 'main'

  const pages = await gh(options.token, 'POST', `/repos/${owner}/${repo}/pages`, {
    source: { branch: defaultBranch, path: '/' },
  })

  // 409 means Pages is already on, which is the re-run case, not a failure.
  if (pages.status !== 201 && pages.status !== 409) {
    throw new SiteError(
      `Could not enable GitHub Pages: ${pages.json?.message ?? `HTTP ${pages.status}`}`,
      pages.status,
    )
  }

  return {
    owner,
    repo,
    pagesUrl,
    repoUrl: `https://github.com/${owner}/${repo}`,
    created,
  }
}

/**
 * Creates a new site by generating from the template repo.
 *
 * Generate, not fork: a fork stays chained to the template's network and
 * advertises it, whereas a generated repo is a clean copy owned outright.
 */
export async function createSiteFromTemplate(
  options: SiteSetupOptions,
): Promise<SiteResult> {
  const owner = await whoami(options.token)
  const [templateOwner, templateRepo] = options.templateRepo.split('/')

  const generated = await gh(
    options.token,
    'POST',
    `/repos/${templateOwner}/${templateRepo}/generate`,
    { owner, name: options.name, private: false, description: 'Website powered by adminCms' },
  )

  let created = true

  if (generated.status === 422 && /already exists/i.test(JSON.stringify(generated.json))) {
    // Re-running against an existing repo configures it instead of failing.
    created = false
  } else if (generated.status !== 201) {
    throw new SiteError(
      `Could not create the repo: ${generated.json?.message ?? `HTTP ${generated.status}`}`,
      generated.status,
    )
  }

  if (created) {
    // Generation is asynchronous — the contents API 404s until the copy lands.
    let ready = false
    for (let attempt = 0; attempt < 15; attempt++) {
      const probe = await gh(
        options.token,
        'GET',
        `/repos/${owner}/${options.name}/contents/content/site.json`,
      )
      if (probe.status === 200) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (!ready) {
      throw new SiteError('The generated repo never became readable.')
    }
  }

  return configureAndPublish(options, owner, options.name, created)
}

/** Connects a repo the user already has. */
export async function connectExistingSite(
  options: SiteSetupOptions & { repoFullName: string },
): Promise<SiteResult> {
  const [owner, repo] = options.repoFullName.split('/')
  if (!owner || !repo) {
    throw new SiteError('Give the repository as owner/name.', 400)
  }

  const found = await gh(options.token, 'GET', `/repos/${owner}/${repo}`)
  if (found.status !== 200) {
    throw new SiteError(
      `Could not find ${options.repoFullName}, or the token cannot see it.`,
      found.status,
    )
  }
  if (!found.json?.permissions?.admin) {
    throw new SiteError(
      `You need admin rights on ${options.repoFullName} to enable Pages on it.`,
      403,
    )
  }

  // An existing repo may not carry the template's config file at all.
  const probe = await gh(
    options.token,
    'GET',
    `/repos/${owner}/${repo}/contents/content/site.json`,
  )
  if (probe.status === 404) {
    throw new SiteError(
      `${options.repoFullName} does not look like a site built from the template — it has no content/site.json.`,
      400,
    )
  }

  return configureAndPublish(options, owner, repo, false)
}
