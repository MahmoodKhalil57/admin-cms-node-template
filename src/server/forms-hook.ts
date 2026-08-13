import type { NodeDb } from '#/db'
import { repoRef } from './static-context'
import { syncDbToRepo } from './forms-sync'

/**
 * Write the node's forms back to the site's declaration after a change.
 *
 * Deliberately swallows its own failures. The form is already saved by the time
 * this runs, and a node with no repository connected — or GitHub having a bad
 * minute — must not turn that into an error the operator sees as "save failed".
 * The outcome rides along on the response instead, so a sync that did not
 * happen is visible rather than silent.
 */
export async function syncFormsToRepo(
  db: NodeDb,
  what: string,
): Promise<{ committed: boolean; reason?: string }> {
  try {
    const ref = await repoRef(db)
    return await syncDbToRepo(ref, db, `forms: ${what}`)
  } catch (error) {
    return {
      committed: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Attach the sync outcome to a REST response without changing its shape. */
export async function withFormsSync(
  db: NodeDb,
  resource: string,
  what: string,
  response: Response,
): Promise<Response> {
  if (resource !== 'forms' || !response.ok) return response

  const sync = await syncFormsToRepo(db, what)
  const body = (await response.json()) as Record<string, unknown>
  return Response.json({ ...body, _sync: sync }, { status: response.status })
}
