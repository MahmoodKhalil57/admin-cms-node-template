import type { NodeEnv } from '../env'

/**
 * The build a project runs, fetched from somewhere public.
 *
 * **This is the piece that makes layer 3 cost the platform nothing.** The
 * obvious way to give a project its code is to read the artifact out of the
 * platform's R2 bucket with the platform's API token — and that is exactly the
 * shortcut the feature exists to avoid, because it would put our key inside
 * every provisioning run an operator triggers.
 *
 * So the artifact is published to a public, versioned location that needs no
 * credential to read at all: a GitHub release on a public repository. Unmetered
 * for public repos, no keys involved, and genuinely zero rather than
 * nearly-zero.
 *
 * `releases/latest/download/…` is a stable URL that always resolves to the most
 * recent release, so a node provisioning a project today gets today's build
 * without anybody updating a version number anywhere.
 */

export interface NodeImage {
  version: string
  mainModule: string
  compatibilityDate: string
  compatibilityFlags: Array<string>
  modules: Array<{ path: string; source: string }>
  assets: Record<string, string>
  migrations: Array<{ name: string; sql: string }>
}

const DEFAULT_REPO = 'MahmoodKhalil57/admincms-node-image'
const ASSET = 'node-image.json'

export function imageUrl(env: NodeEnv): string {
  const repo = env.IMAGE_REPO ?? DEFAULT_REPO
  return `https://github.com/${repo}/releases/latest/download/${ASSET}`
}

export class ImageUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageUnavailable'
  }
}

/**
 * Fetches the current build.
 *
 * No `Authorization` header, on purpose and worth keeping that way — the day
 * this needs one is the day layer 3 stops being free, and it should be a
 * deliberate decision rather than a quiet addition.
 */
export async function fetchImage(env: NodeEnv): Promise<NodeImage> {
  const url = imageUrl(env)
  let response: Response
  try {
    response = await fetch(url, {
      // Follows the release redirect to the asset itself.
      redirect: 'follow',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    throw new ImageUnavailable(
      `Could not reach ${url}: ${error instanceof Error ? error.message : 'network error'}`,
    )
  }

  if (!response.ok) {
    throw new ImageUnavailable(
      `The build could not be downloaded (${response.status}). It is published at ${url}.`,
    )
  }

  const image = (await response.json().catch(() => null)) as NodeImage | null
  if (!image?.mainModule || !Array.isArray(image.modules)) {
    throw new ImageUnavailable('The build that came back is not one we recognise.')
  }
  return image
}

export type Binding =
  | { type: 'd1'; name: string; id: string }
  | { type: 'kv_namespace'; name: string; namespace_id: string }
  | { type: 'r2_bucket'; name: string; bucket_name: string }
  | { type: 'plain_text'; name: string; text: string }
  | { type: 'secret_text'; name: string; text: string }
  | { type: 'assets'; name: string }

/**
 * The multipart body for a script upload.
 *
 * Each module is added with its path as **both** the part name and the
 * filename. Cloudflare keys the module by the filename, so a part named
 * `_libs/x.mjs` carrying a filename of `x.mjs` uploads cleanly and then fails
 * at boot with `No such module` — which is a long way from the mistake.
 */
export function buildUploadForm(
  image: NodeImage,
  bindings: Array<Binding>,
  /**
   * The token returned by uploading the static files.
   *
   * Without it the Worker runs and serves nothing: the document renders, and
   * every stylesheet and script it asks for falls through to the same handler
   * and comes back as HTML. The health check passes, the API answers, and the
   * panel is a blank page — which is a great deal harder to diagnose than a
   * Worker that failed to start.
   */
  assetsJwt?: string | null,
): FormData {
  const form = new FormData()
  const metadata: Record<string, unknown> = {
    main_module: image.mainModule,
    compatibility_date: image.compatibilityDate,
    compatibility_flags: image.compatibilityFlags,
    bindings,
  }
  if (assetsJwt) metadata.assets = { jwt: assetsJwt }
  form.set('metadata', JSON.stringify(metadata))
  for (const module of image.modules) {
    form.set(
      module.path,
      new File([module.source], module.path, {
        type: 'application/javascript+module',
      }),
    )
  }
  return form
}
