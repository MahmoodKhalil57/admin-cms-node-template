import { parse, stringify } from 'yaml'

import type { Principal } from './authz'
import { allows, can } from './authz'
import { CONFIG_PATH, decode, gh } from './static-store'
import type { ProxyTarget } from './cms-proxy'
import { virtualCollections } from './cms-virtual'

/**
 * The CMS the repository defined, as this particular account may see it.
 *
 * Sveltia reads one config file and builds its whole interface from it. That is
 * the seam this uses. The repository's own config is taken as written — every
 * widget, every preview, every hint the designer put there — and two things are
 * done to it before it is handed over:
 *
 * 1. **Collections this account may not touch are removed.** Not hidden with
 *    CSS and not refused on save: absent. A designer restricted to pages opens
 *    an editor that has pages in it, rather than one with five things they are
 *    told off for clicking.
 *
 * 2. **The backend is repointed at this node.** Same `github` backend Sveltia
 *    already implements, aimed at a proxy that authorises every call. Nothing
 *    about the editing experience changes; nobody is handed a repository token.
 *
 * Which is what keeps this native. There is no translation into some
 * intermediate model and back — the config that arrives is the config the
 * repository wrote, minus what this reader has no business seeing.
 *
 * Removal is the visible half of the rule and never the enforcing half. A
 * collection taken out here is also refused on write by the proxy, because a
 * config is a document the browser has and can edit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>

/** Where the node answers, from the request that asked. */
export function cmsOrigin(request: Request): string {
  return new URL(request.url).origin
}

/**
 * Whether this account may see a collection at all.
 *
 * Read rather than write: seeing a collection they cannot save is a reasonable
 * state — a designer may need to read the settings that decide what their pages
 * do — and one they can save but not see is not.
 */
function visible(principal: Principal, collection: string, file: string | null) {
  return allows(principal, 'content:read', {
    collection,
    file,
    path: null,
  })
}

/**
 * The repo's config, filtered and repointed.
 *
 * Returns YAML because that is what Sveltia asked for; the round trip through
 * an object is what lets the filtering be structural rather than textual.
 */
export async function buildConfig(
  target: ProxyTarget,
  principal: Principal,
  request: Request,
  enabledFeatures: Array<string>,
): Promise<string> {
  const response = await gh(
    target,
    'GET',
    `/repos/${target.owner}/${target.repo}/contents/${CONFIG_PATH}`,
  )
  if (response.status !== 200 || !response.json?.content) {
    throw new Error('This site has no CMS configuration yet.')
  }

  const config = parse(decode(response.json.content)) as Raw
  const origin = cmsOrigin(request)

  // The same GitHub backend, aimed at this node. `api_root` ending in `/api/v3`
  // is left alone by Sveltia's normalisation; anything else has a path appended
  // to it, and the endpoint would move out from under the proxy.
  config.backend = {
    ...(config.backend ?? {}),
    name: 'github',
    repo: `${target.owner}/${target.repo}`,
    branch: config.backend?.branch ?? 'master',
    base_url: `${origin}/api/cms`,
    auth_endpoint: 'auth',
    api_root: `${origin}/api/cms/api/v3`,
    auth_methods: ['oauth'],
  }

  const collections = Array.isArray(config.collections) ? config.collections : []

  config.collections = collections
    .map((collection: Raw) => {
      const name = String(collection.name ?? '')
      if (!name) return null

      if (Array.isArray(collection.files)) {
        // A `files` collection is a set of singletons, and a rule may name one
        // of them — so it is filtered entry by entry, and disappears only when
        // nothing in it survives.
        const files = collection.files.filter((entry: Raw) =>
          visible(principal, name, String(entry.name ?? '')),
        )
        if (!files.length) return null
        return { ...collection, files }
      }

      if (!visible(principal, name, null)) return null
      return collection
    })
    .filter(Boolean)

  // The node's own collections, added to the repo's. One sidebar with the
  // site's content and the node's data in it, and no way to tell from the
  // inside which is which — that is what makes this a dashboard rather than
  // two dashboards sharing a stylesheet.
  ;(config.collections as Array<unknown>).push(
    ...virtualCollections(principal, enabledFeatures),
  )

  // Said once, here, rather than left for a save to discover. A reader who
  // cannot write anything gets an editor that says so.
  if (!can(principal, 'content:write')) {
    for (const collection of config.collections as Array<Raw>) {
      collection.create = false
      collection.delete = false
    }
  }

  // The CMS lives on the site's own origin, so this stays as the repo wrote it.
  // Restated only when absent, because Sveltia needs somewhere to put uploads.
  config.media_folder ??= 'media/uploads'
  config.public_folder ??= '/media/uploads'

  return stringify(config)
}
