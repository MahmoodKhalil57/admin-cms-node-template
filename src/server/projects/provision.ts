import { eq } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { projects } from '#/db/schema'
import type { NodeEnv } from '../env'
import { record } from '../events'
import { currentInfra, infraToken, missingForBuild } from '../infra'
import {
  accountSubdomain,
  createD1,
  createKv,
  deleteD1,
  deleteKv,
  deleteWorker,
  enableWorkersDev,
  explain,
  findD1,
  findKv,
  queryD1,
  uploadWorker,
} from './cloudflare'
import type { Account } from './cloudflare'
import { buildUploadForm, fetchImage } from './image'
import { uploadAssets } from './assets'
import type { Binding } from './image'

/**
 * Building a project on the operator's own infrastructure.
 *
 * Layer 3. Master creates nodes on the platform's account and pays for them;
 * this creates projects on the **operator's** account, which is what makes a
 * whitelabel possible — layer 2 becomes somebody else's platform, people sign
 * up to it, and what they build never touches us.
 *
 * Two properties hold this together, and both are load-bearing:
 *
 * 1. **None of the platform's keys are involved.** Every Cloudflare call
 *    carries the operator's OAuth token, and the build comes from a public
 *    GitHub release that needs no credential at all.
 * 2. **It is idempotent, keyed on the slug.** Master's provisioning already had
 *    to be, and it matters more here: the person retrying is not us, and the
 *    resources are not ours to clean up. Everything below finds-or-creates.
 */

/** `p-<slug>` throughout, so nothing here can name a resource it did not make. */
export function resourceNames(slug: string) {
  return {
    worker: `p-${slug}`,
    database: `p-${slug}`,
    kv: `p-${slug}-session`,
    bucket: `p-${slug}-media`,
  }
}

export type Outcome =
  | { ok: true; hostname: string | null; imageVersion: string }
  | { ok: false; error: string }

/*
  Two to thirty-two, starting and ending on a letter or a digit.

  The bounds are Cloudflare's, not ours: a Worker name and a D1 name both have
  to survive being used as a hostname label. The earlier version of this made
  the middle section one-or-more, which quietly refused every two-character
  name while the message beside it promised they were fine.
*/
const SLUG = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/

export function badSlug(slug: string): string | null {
  if (!SLUG.test(slug)) {
    return 'A project name is lowercase letters, numbers and hyphens, between two and thirty-two characters.'
  }
  return null
}

/**
 * Creates everything a project needs, or says why it could not.
 *
 * Errors come back as sentences rather than being thrown, because every one of
 * them is going to be read by an operator looking at their own Cloudflare
 * account — a plan limit they did not know about, a grant that has expired, a
 * name already taken. See `explain`.
 */
export async function provisionProject(
  env: NodeEnv,
  db: NodeDb,
  slug: string,
  options: { ownerUserId?: string | null } = {},
): Promise<Outcome> {
  const connection = await infraToken(env, db, 'cloudflare')
  if (!connection?.accountId) {
    return {
      ok: false,
      error:
        'Cloudflare is not connected, or the connection has run out. Connect it again on the Projects screen.',
    }
  }

  /*
    Refused here rather than by Cloudflare, three calls in.

    A grant that cannot create a database fails on the first create with a 403
    and a message about permissions, halfway through a job that has already
    started. Checking what was actually granted before touching anything means
    the operator is told which capability is missing, and nothing has been made
    on their account that has to be cleaned up.
  */
  const short = missingForBuild(
    (await currentInfra(db, 'cloudflare'))?.scopes ?? [],
  )
  if (short.length > 0) {
    return {
      ok: false,
      error: `The Cloudflare connection cannot create infrastructure: it is missing ${short.join(', ')}. Reconnect Cloudflare on the Projects feature page — a grant only carries what was asked for on the day it was made.`,
    }
  }

  const account: Account = {
    token: connection.token,
    accountId: connection.accountId,
  }
  const names = resourceNames(slug)

  // Before anything is created on somebody's account: if the build cannot be
  // downloaded there is nothing to put in the Worker, and half a project is
  // worse than none.
  let image
  try {
    image = await fetchImage(env)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The build is unavailable.',
    }
  }

  /* --- the database ------------------------------------------------------ */

  let databaseId: string | null = null
  const existingD1 = await findD1(account, names.database)
  if (existingD1.ok && existingD1.result?.length) {
    databaseId = existingD1.result[0]!.uuid
  } else {
    const made = await createD1(account, names.database)
    if (!made.ok || !made.result) {
      return { ok: false, error: explain(made, 'Creating the database') }
    }
    databaseId = made.result.uuid
  }

  // Applied here rather than on the project's first request. A cold Worker that
  // migrates at request time answers 522 while it does, which is a lesson
  // already paid for once.
  for (const migration of image.migrations) {
    const applied = await queryD1(account, databaseId, migration.sql)
    if (!applied.ok) {
      // A migration that has already run is not a failure — this is the retry
      // path, and idempotence is the whole point.
      const message = applied.errors?.[0]?.message ?? ''
      const harmless =
        /already exists|duplicate column/i.test(message) || applied.status === 409
      if (!harmless) {
        return {
          ok: false,
          error: explain(applied, `Applying ${migration.name}`),
        }
      }
    }
  }

  /* --- sessions ---------------------------------------------------------- */

  let kvId: string | null = null
  const existingKv = await findKv(account, names.kv)
  if (existingKv) {
    kvId = existingKv.id
  } else {
    const made = await createKv(account, names.kv)
    if (!made.ok || !made.result) {
      return { ok: false, error: explain(made, 'Creating the session store') }
    }
    kvId = made.result.id
  }

  /* --- the Worker -------------------------------------------------------- */

  /*
    No bucket, and it is not an oversight.

    Cloudflare's OAuth vocabulary has no R2 scope at all — there is no
    `r2.write` to ask for — so a project built on a delegated grant cannot be
    given storage of its own. The binding is simply absent, and the project runs
    without it: forms, the diary, the team and the panel all work; uploading a
    file a buyer downloads does not.

    Said out loud rather than left to be discovered, and revisitable the day
    Cloudflare adds the scope: one entry in `INFRA_SCOPES` and one binding here.
  */
  /*
    The static files, before the script that serves them.

    In this order because the upload metadata has to name the completion token,
    and there is no way to add one afterwards without uploading the script
    again.
  */
  let assetsJwt: string | null = null
  try {
    assetsJwt = await uploadAssets(account, names.worker, image.assets ?? {})
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Uploading the project's files: ${error.message}`
          : "The project's files could not be uploaded.",
    }
  }

  const bindings: Array<Binding> = [
    { type: 'd1', name: 'DB', id: databaseId },
    { type: 'kv_namespace', name: 'KV', namespace_id: kvId },
    // Named `ASSETS` because that is what the built Worker reaches for.
    ...(assetsJwt ? [{ type: 'assets' as const, name: 'ASSETS' }] : []),
    { type: 'plain_text', name: 'NODE_ID', text: slug },
    { type: 'plain_text', name: 'NODE_NAME', text: slug },
    // Its own signing secret, derived per project so two projects on one
    // account cannot read each other's sessions.
    { type: 'secret_text', name: 'BETTER_AUTH_SECRET', text: await secretFor(env, slug) },
  ]

  const upload = await uploadWorker(
    account,
    names.worker,
    buildUploadForm(image, bindings, assetsJwt),
  )
  if (!upload.ok) {
    return { ok: false, error: explain(upload, 'Uploading the project') }
  }

  /* --- where it answers -------------------------------------------------- */

  let hostname: string | null = null
  const enabled = await enableWorkersDev(account, names.worker)
  if (enabled.ok) {
    const subdomain = await accountSubdomain(account)
    if (subdomain) hostname = `${names.worker}.${subdomain}.workers.dev`
  }

  await db
    .update(projects)
    .set({
      status: 'active',
      cloudflareAccountId: account.accountId,
      workerName: names.worker,
      hostname,
      d1DatabaseId: databaseId,
      kvNamespaceId: kvId,
      r2Bucket: null,
      imageVersion: image.version,
      lastError: null,
    })
    .where(eq(projects.slug, slug))

  await record(db, {
    name: 'project.created',
    subjectType: 'projects',
    subjectId: slug,
    detail: { hostname, imageVersion: image.version, ownerUserId: options.ownerUserId },
  })

  return { ok: true, hostname, imageVersion: image.version }
}

/**
 * Takes a project's infrastructure down.
 *
 * The Worker and the session store go; **the database stays**. It holds
 * somebody's accounts, their enquiries and possibly their orders, and deleting
 * it is a decision nobody should be able to make by clicking Destroy on the
 * wrong row. The row here is marked so the operator can see it happened, and
 * removing the data is a deliberate act in their own Cloudflare dashboard.
 */
export async function destroyProject(
  env: NodeEnv,
  db: NodeDb,
  slug: string,
  options: { alsoDatabase?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const connection = await infraToken(env, db, 'cloudflare')
  if (!connection?.accountId) {
    return { ok: false, error: 'Cloudflare is not connected, or the connection has run out.' }
  }
  const account: Account = { token: connection.token, accountId: connection.accountId }
  const names = resourceNames(slug)

  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1)
  if (!row) return { ok: false, error: 'No such project.' }

  // Deleted by derived name only, never by anything stored — the same rule
  // that keeps master away from resources it did not create.
  await deleteWorker(account, names.worker)
  if (row.kvNamespaceId) await deleteKv(account, row.kvNamespaceId)
  if (options.alsoDatabase && row.d1DatabaseId) {
    await deleteD1(account, row.d1DatabaseId)
  }

  await db
    .update(projects)
    .set({
      status: 'suspended',
      workerName: null,
      hostname: null,
      kvNamespaceId: null,
      d1DatabaseId: options.alsoDatabase ? null : row.d1DatabaseId,
    })
    .where(eq(projects.slug, slug))

  await record(db, {
    name: 'project.destroyed',
    subjectType: 'projects',
    subjectId: slug,
    detail: { keptDatabase: !options.alsoDatabase },
  })

  return { ok: true }
}

/**
 * A per-project signing secret, derived rather than stored.
 *
 * From the node's own secret and the slug, so it is stable across a rebuild —
 * a project whose secret changed on every provision would sign everybody out
 * each time it was rolled — and different per project without a table to keep.
 */
async function secretFor(env: NodeEnv, slug: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.BETTER_AUTH_SECRET ?? 'node'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`project:${slug}`),
  )
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}
