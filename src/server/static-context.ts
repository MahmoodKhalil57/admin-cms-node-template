import type { NodeDb } from '#/db'
import { currentConnection } from './github-store'
import type { RepoRef } from './static-store'
import { StaticError, loadModel } from './static-store'
import type { StaticCollection } from './sveltia'

/**
 * The repo this node edits, from the connection made for publishing.
 *
 * Deliberately reuses that connection: the operator already granted access to
 * this repository to publish the site, and asking again to edit its content
 * would be asking twice for the same thing.
 */
export async function repoRef(db: NodeDb): Promise<RepoRef> {
  const connection = await currentConnection(db)
  if (!connection?.repoOwner || !connection.repoName) {
    throw new StaticError(
      'Connect GitHub and publish a site before editing its content.',
      400,
    )
  }
  return {
    token: connection.accessToken,
    owner: connection.repoOwner,
    repo: connection.repoName,
  }
}

export async function collectionFor(
  ref: RepoRef,
  name: string,
): Promise<{ collection: StaticCollection; yaml: string }> {
  const { collections, yaml } = await loadModel(ref)
  const collection = collections.find((entry) => entry.name === name)
  if (!collection) throw new StaticError(`Unknown collection "${name}".`, 404)
  return { collection, yaml }
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof StaticError ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: message }, { status })
}
