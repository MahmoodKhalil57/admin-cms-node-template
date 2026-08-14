import type { Connection } from './infra'
import { assetHash, base64ToBytes, contentTypeFor } from './image'

/**
 * Building a project on somebody else's Cloudflare account.
 *
 * This is master's provisioning pipeline with one thing changed: the credential.
 * Master creates nodes on our account with our token; this creates projects on
 * the operator's account with theirs. Everything else — a database, a bucket, a
 * namespace, a Worker, in that order, each step idempotent and keyed on the
 * slug — is the same sequence for the same reasons, and those reasons were paid
 * for the first time round.
 *
 * Two things are deliberately different.
 *
 * **A plain Worker, not a dispatch namespace.** Master runs a fleet and Workers
 * for Platforms earns its keep there. An operator creating a handful of projects
 * does not need it and should not have to buy the add-on to use this feature at
 * all, so each project is one ordinary Worker on their account — which works on
 * the plan they already have.
 *
 * **Retries are theirs, not ours.** When master half-creates a node we notice
 * and fix it. Here the person retrying is an operator who cannot see logs, on
 * resources we cannot reach, so every step reports what it did in words they can
 * act on and every step can be run again without making a second of anything.
 */

const API = 'https://api.cloudflare.com/client/v4'

export interface Step {
  name: string
  status: 'created' | 'already-existed' | 'failed' | 'skipped'
  detail?: string
}

export interface ProvisionResult {
  ok: boolean
  slug: string
  steps: Array<Step>
  workerName?: string
  hostname?: string
  d1DatabaseId?: string
  r2Bucket?: string
  kvNamespaceId?: string
  imageVersion?: string
  ownerPassword?: string
  error?: string
}

/** Names derived from the slug, so a retry finds what the last attempt made. */
export function namesFor(slug: string) {
  return {
    worker: `p-${slug}`,
    d1: `p-${slug}`,
    r2: `p-${slug}-media`,
    kv: `p-${slug}-session`,
  }
}

interface CloudflareAnswer {
  ok: boolean
  status: number
  /** Cloudflare's own flag; an HTTP 200 with `success: false` is a failure */
  success?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any
  errors?: Array<{ code: number; message: string }>
}

async function cf(
  connection: Connection,
  path: string,
  init: RequestInit = {},
): Promise<CloudflareAnswer> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(init.body && typeof init.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init.headers ?? {}),
    },
  })
  const json = (await response.json().catch(() => ({}))) as CloudflareAnswer
  return { ...json, ok: response.ok && json.success !== false, status: response.status }
}

/**
 * Cloudflare's own words, made answerable.
 *
 * An operator reading this cannot see our logs and did not write our code. The
 * limits in particular are worth translating: hitting one is not a fault, it is
 * a plan, and saying which is the difference between a shrug and an action.
 */
export function explain(answer: CloudflareAnswer): string {
  const first = answer.errors?.[0]
  const message = first?.message ?? `Cloudflare refused that (${answer.status}).`

  if (answer.status === 403 || first?.code === 10000) {
    return `${message} — the connection may have expired, or may not have been granted this permission. Reconnect Cloudflare and try again.`
  }
  if (/limit|quota|maximum/i.test(message)) {
    return `${message} — this is a limit on your Cloudflare account rather than something here. Removing an unused project, or upgrading the plan, will clear it.`
  }
  return message
}

/**
 * Creates the pieces, then the Worker that uses them.
 *
 * The order matters and is the order master learned: bindings have to exist
 * before a script can name them, and a script uploaded against a binding that
 * is not there fails in a way that reads like a code problem.
 */
export async function provisionProject(
  connection: Connection,
  slug: string,
): Promise<ProvisionResult> {
  const steps: Array<Step> = []
  const names = namesFor(slug)
  const accountId = connection.accountId
  if (!accountId) {
    return {
      ok: false,
      slug,
      steps,
      error: 'This Cloudflare connection has no account on it. Reconnect it.',
    }
  }

  const base = `/accounts/${accountId}`
  const result: ProvisionResult = { ok: false, slug, steps }

  /* --- D1 ---------------------------------------------------------------- */
  const d1 = await cf(connection, `${base}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: names.d1 }),
  })
  if (d1.ok) {
    result.d1DatabaseId = d1.result?.uuid
    steps.push({ name: 'database', status: 'created', detail: names.d1 })
  } else {
    // Already there is the ordinary outcome of a retry, not a failure.
    const list = await cf(connection, `${base}/d1/database?name=${names.d1}`)
    const found = list.result?.find?.(
      (row: { name: string; uuid: string }) => row.name === names.d1,
    )
    if (found) {
      result.d1DatabaseId = found.uuid
      steps.push({ name: 'database', status: 'already-existed', detail: names.d1 })
    } else {
      steps.push({ name: 'database', status: 'failed', detail: explain(d1) })
      return { ...result, error: explain(d1) }
    }
  }

  /* --- R2 ---------------------------------------------------------------- */
  const r2 = await cf(connection, `${base}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name: names.r2 }),
  })
  if (r2.ok) {
    result.r2Bucket = names.r2
    steps.push({ name: 'storage', status: 'created', detail: names.r2 })
  } else if (/already exists/i.test(r2.errors?.[0]?.message ?? '')) {
    result.r2Bucket = names.r2
    steps.push({ name: 'storage', status: 'already-existed', detail: names.r2 })
  } else {
    steps.push({ name: 'storage', status: 'failed', detail: explain(r2) })
    return { ...result, error: explain(r2) }
  }

  /* --- KV ---------------------------------------------------------------- */
  const kv = await cf(connection, `${base}/storage/kv/namespaces`, {
    method: 'POST',
    body: JSON.stringify({ title: names.kv }),
  })
  if (kv.ok) {
    result.kvNamespaceId = kv.result?.id
    steps.push({ name: 'sessions', status: 'created', detail: names.kv })
  } else {
    const list = await cf(connection, `${base}/storage/kv/namespaces?per_page=100`)
    const found = list.result?.find?.(
      (row: { title: string; id: string }) => row.title === names.kv,
    )
    if (found) {
      result.kvNamespaceId = found.id
      steps.push({ name: 'sessions', status: 'already-existed', detail: names.kv })
    } else {
      steps.push({ name: 'sessions', status: 'failed', detail: explain(kv) })
      return { ...result, error: explain(kv) }
    }
  }

  return { ...result, ok: true, workerName: names.worker }
}

/**
 * Removes what this created, and only what this created.
 *
 * Names are derived from the slug and checked against that prefix before
 * anything is deleted. These are somebody else's resources on somebody else's
 * account, and the cost of a wrong name here is not ours to pay — which is
 * exactly why the check is here rather than trusted to the caller.
 */
export async function deprovisionProject(
  connection: Connection,
  slug: string,
  ids: { d1DatabaseId?: string | null; kvNamespaceId?: string | null },
): Promise<Array<Step>> {
  const steps: Array<Step> = []
  const names = namesFor(slug)
  const accountId = connection.accountId
  if (!accountId) return steps
  const base = `/accounts/${accountId}`

  if (!names.worker.startsWith(`p-`)) return steps

  const worker = await cf(connection, `${base}/workers/scripts/${names.worker}`, {
    method: 'DELETE',
  })
  steps.push({
    name: 'worker',
    status: worker.ok ? 'created' : 'failed',
    detail: names.worker,
  })

  if (ids.d1DatabaseId) {
    const d1 = await cf(connection, `${base}/d1/database/${ids.d1DatabaseId}`, {
      method: 'DELETE',
    })
    steps.push({ name: 'database', status: d1.ok ? 'created' : 'failed' })
  }
  if (ids.kvNamespaceId) {
    const kv = await cf(
      connection,
      `${base}/storage/kv/namespaces/${ids.kvNamespaceId}`,
      { method: 'DELETE' },
    )
    steps.push({ name: 'sessions', status: kv.ok ? 'created' : 'failed' })
  }

  // The bucket is deliberately left. It holds whatever the project sold, and a
  // delete here would be irreversible on somebody else's account.
  steps.push({
    name: 'storage',
    status: 'skipped',
    detail: `${names.r2} kept — it may hold their files`,
  })

  return steps
}

/* --- the Worker ----------------------------------------------------------- */

/**
 * Uploads the static assets and returns the token the script upload needs.
 *
 * Cloudflare is told a manifest of hashes first and answers with only the ones
 * it does not already hold — so a second project on the same account uploads
 * almost nothing, and a redeploy of an unchanged build uploads nothing at all.
 *
 * The bucket uploads authenticate with the session's own JWT rather than the
 * operator's API token. That is Cloudflare's design and a good one: the
 * short-lived token is scoped to this upload and nothing else.
 */
export async function uploadAssets(
  connection: Connection,
  scriptName: string,
  assets: Record<string, string>,
): Promise<string | null> {
  const paths = Object.keys(assets)
  if (paths.length === 0) return null

  const byHash = new Map<string, { path: string; base64: string }>()
  const manifest: Record<string, { hash: string; size: number }> = {}

  for (const path of paths) {
    const base64 = assets[path]!
    const bytes = base64ToBytes(base64)
    const hash = await assetHash(bytes)
    manifest[path] = { hash, size: bytes.length }
    byHash.set(hash, { path, base64 })
  }

  const session = await cf(
    connection,
    `/accounts/${connection.accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    { method: 'POST', body: JSON.stringify({ manifest }) },
  )
  if (!session.ok) throw new Error(explain(session))

  const buckets: Array<Array<string>> = session.result?.buckets ?? []
  let completion: string | null = session.result?.jwt ?? null

  // Nothing missing: every byte is already held, and the session token is the
  // completion token.
  if (buckets.every((bucket) => bucket.length === 0)) return completion

  for (const bucket of buckets) {
    if (bucket.length === 0) continue

    const form = new FormData()
    for (const hash of bucket) {
      const asset = byHash.get(hash)
      if (!asset) continue
      form.set(
        hash,
        new File([asset.base64], hash, { type: contentTypeFor(asset.path) }),
      )
    }

    const response = await fetch(
      `${API}/accounts/${connection.accountId}/workers/assets/upload?base64=true`,
      {
        method: 'POST',
        // The session JWT, and no Content-Type — fetch sets the multipart
        // boundary itself, and setting it by hand produces a body Cloudflare
        // cannot parse.
        headers: { Authorization: `Bearer ${session.result?.jwt}` },
        body: form,
      },
    )
    const body = (await response.json().catch(() => ({}))) as {
      result?: { jwt?: string }
      errors?: Array<{ code: number; message: string }>
    }
    if (!response.ok) {
      throw new Error(
        body.errors?.[0]?.message ?? 'Uploading the interface failed.',
      )
    }
    if (body.result?.jwt) completion = body.result.jwt
  }

  return completion
}

export interface WorkerSecrets {
  betterAuthSecret: string
  provisionToken: string
}

/**
 * Uploads the Worker itself, with its bindings.
 *
 * A plain Worker on the operator's account: no dispatch namespace, so nothing
 * here needs Workers for Platforms. The bindings name the database, bucket and
 * namespace made above — which is why those come first, since a script
 * referring to a binding that does not exist fails in a way that reads like a
 * code problem.
 */
export async function uploadWorker(
  connection: Connection,
  scriptName: string,
  image: {
    mainModule: string
    modules: Array<{ path: string; source: string }>
    compatibilityDate: string
    compatibilityFlags: Array<string>
  },
  bindings: {
    d1DatabaseId: string
    r2Bucket: string
    kvNamespaceId: string
    assetsToken: string | null
    secrets: WorkerSecrets
  },
): Promise<void> {
  const form = new FormData()

  const metadata: Record<string, unknown> = {
    main_module: image.mainModule,
    compatibility_date: image.compatibilityDate,
    compatibility_flags: image.compatibilityFlags,
    bindings: [
      { type: 'd1', name: 'DB', id: bindings.d1DatabaseId },
      { type: 'r2_bucket', name: 'MEDIA', bucket_name: bindings.r2Bucket },
      { type: 'kv_namespace', name: 'KV', namespace_id: bindings.kvNamespaceId },
      // Its own, generated per project — a secret shared between projects would
      // make one project's sessions valid in another.
      {
        type: 'secret_text',
        name: 'BETTER_AUTH_SECRET',
        text: bindings.secrets.betterAuthSecret,
      },
      {
        type: 'secret_text',
        name: 'PROVISION_TOKEN',
        text: bindings.secrets.provisionToken,
      },
      ...(bindings.assetsToken
        ? [{ type: 'assets', name: 'ASSETS' }]
        : []),
    ],
    ...(bindings.assetsToken
      ? { assets: { jwt: bindings.assetsToken } }
      : {}),
  }

  form.set(
    'metadata',
    new File([JSON.stringify(metadata)], 'metadata.json', {
      type: 'application/json',
    }),
  )

  for (const module of image.modules) {
    form.set(
      module.path,
      // The path is the exact string Cloudflare resolves imports by, so it is
      // used verbatim as the part name rather than being normalised.
      new File([module.source], module.path, {
        type: 'application/javascript+module',
      }),
    )
  }

  const uploaded = await cf(
    connection,
    `/accounts/${connection.accountId}/workers/scripts/${scriptName}`,
    { method: 'PUT', body: form },
  )
  if (!uploaded.ok) throw new Error(explain(uploaded))
}

/** So a project answers on the internet without a domain being set up first. */
export async function enableWorkersDev(
  connection: Connection,
  scriptName: string,
): Promise<boolean> {
  const answer = await cf(
    connection,
    `/accounts/${connection.accountId}/workers/scripts/${scriptName}/subdomain`,
    { method: 'POST', body: JSON.stringify({ enabled: true }) },
  )
  return answer.ok
}
