const API = 'https://api.cloudflare.com/client/v4'

/**
 * Cloudflare, on somebody else's account.
 *
 * Every call here carries the **operator's** OAuth token. Nothing in this file
 * can reach the platform's account, and that is the property the whole feature
 * exists to have: a project built through it costs the platform nothing and
 * uses none of its keys.
 *
 * A trimmed copy of master's client rather than a shared one, deliberately.
 * Master's talks to *our* account with an API token that can do anything;
 * sharing the module would have put one import between an operator's project
 * and the platform's own infrastructure.
 */

export interface Account {
  token: string
  accountId: string
}

export interface CfResult<T> {
  ok: boolean
  status: number
  result?: T
  errors?: Array<{ code: number; message: string }>
}

export async function cf<T = unknown>(
  account: Account,
  path: string,
  init: RequestInit = {},
): Promise<CfResult<T>> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${account.token}`)
  // Never set Content-Type for a FormData body: doing so overwrites the
  // boundary fetch generated, and Cloudflare then reads the `--boundary` line
  // as JavaScript and rejects the upload with a syntax error at line 1.
  if (init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${API}${path}`, { ...init, headers })
  const text = await response.text()

  let body: { result?: T; errors?: Array<{ code: number; message: string }> } = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { errors: [{ code: 0, message: text.slice(0, 300) || 'non-JSON response' }] }
  }

  return { ok: response.ok, status: response.status, result: body.result, errors: body.errors }
}

/**
 * What Cloudflare said, in words an operator can act on.
 *
 * This is somebody else's account being told they cannot do something, so the
 * message has to survive being read by a person who has never seen our code.
 * A raw error code and a stack trace tell them nothing; the plan limit they
 * did not know about is the actual answer nine times out of ten.
 */
export function explain(result: CfResult<unknown>, doing: string): string {
  const first = result.errors?.[0]
  if (!first) return `${doing} failed (${result.status}).`

  if (result.status === 401 || result.status === 403) {
    return `${doing} was refused: your Cloudflare connection does not cover it. Reconnect Cloudflare, and if it keeps happening the grant is missing a permission.`
  }
  // Cloudflare's own words are usually better than ours — they know what the
  // limit is and we are guessing.
  return `${doing} failed: ${first.message}`
}

export async function whoami(
  token: string,
): Promise<{ accounts: Array<{ id: string; name: string }> } | null> {
  const listed = await cf<Array<{ id: string; name: string }>>(
    { token, accountId: '' },
    '/accounts',
  )
  if (!listed.ok || !listed.result) return null
  return { accounts: listed.result.map((row) => ({ id: row.id, name: row.name })) }
}

export async function createD1(account: Account, name: string) {
  return cf<{ uuid: string; name: string }>(
    account,
    `/accounts/${account.accountId}/d1/database`,
    { method: 'POST', body: JSON.stringify({ name }) },
  )
}

export async function findD1(account: Account, name: string) {
  return cf<Array<{ uuid: string; name: string }>>(
    account,
    `/accounts/${account.accountId}/d1/database?name=${encodeURIComponent(name)}`,
  )
}

export async function queryD1(account: Account, databaseId: string, sql: string) {
  return cf(
    account,
    `/accounts/${account.accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify({ sql }) },
  )
}

export async function deleteD1(account: Account, databaseId: string) {
  return cf(account, `/accounts/${account.accountId}/d1/database/${databaseId}`, {
    method: 'DELETE',
  })
}

export async function createKv(account: Account, title: string) {
  return cf<{ id: string; title: string }>(
    account,
    `/accounts/${account.accountId}/storage/kv/namespaces`,
    { method: 'POST', body: JSON.stringify({ title }) },
  )
}

export async function findKv(account: Account, title: string) {
  const listed = await cf<Array<{ id: string; title: string }>>(
    account,
    `/accounts/${account.accountId}/storage/kv/namespaces?per_page=100`,
  )
  if (!listed.ok || !listed.result) return null
  return listed.result.find((row) => row.title === title) ?? null
}

export async function deleteKv(account: Account, namespaceId: string) {
  return cf(
    account,
    `/accounts/${account.accountId}/storage/kv/namespaces/${namespaceId}`,
    { method: 'DELETE' },
  )
}

/**
 * Uploads a plain Worker.
 *
 * A plain Worker rather than a script in a dispatch namespace, and that is a
 * cost decision rather than a technical one. Workers for Platforms is a
 * standing monthly charge on top of a paid plan; master needs it because it
 * runs a fleet, and an operator creating a handful of projects should not be
 * asked to buy it. One ordinary Worker per project works on the plan they
 * already have and can be genuinely free at small scale.
 */
export async function uploadWorker(
  account: Account,
  scriptName: string,
  form: FormData,
) {
  return cf(
    account,
    `/accounts/${account.accountId}/workers/scripts/${scriptName}`,
    { method: 'PUT', body: form },
  )
}

export async function deleteWorker(account: Account, scriptName: string) {
  return cf(
    account,
    `/accounts/${account.accountId}/workers/scripts/${scriptName}?force=true`,
    { method: 'DELETE' },
  )
}

/** Puts the Worker on `<name>.<their subdomain>.workers.dev`. */
export async function enableWorkersDev(account: Account, scriptName: string) {
  return cf(
    account,
    `/accounts/${account.accountId}/workers/scripts/${scriptName}/subdomain`,
    { method: 'POST', body: JSON.stringify({ enabled: true }) },
  )
}

export async function accountSubdomain(account: Account): Promise<string | null> {
  const found = await cf<{ subdomain: string }>(
    account,
    `/accounts/${account.accountId}/workers/subdomain`,
  )
  return found.ok ? (found.result?.subdomain ?? null) : null
}
