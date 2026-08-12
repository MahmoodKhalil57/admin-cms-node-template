import { desc } from 'drizzle-orm'

import type { NodeDb } from '#/db'
import { githubConnections } from '#/db/schema'

export interface PublicConnection {
  connected: boolean
  login?: string
  repoOwner?: string | null
  repoName?: string | null
  pagesUrl?: string | null
  repoUrl?: string | null
}

/** A node publishes one site, so the newest row is the connection. */
export async function currentConnection(db: NodeDb) {
  const [row] = await db
    .select()
    .from(githubConnections)
    .orderBy(desc(githubConnections.id))
    .limit(1)
  return row
}

/**
 * Strips the access token.
 *
 * The token is a live GitHub credential with `public_repo` scope; nothing that
 * leaves this Worker may carry it.
 */
export function redactConnection(
  row: Awaited<ReturnType<typeof currentConnection>>,
): PublicConnection {
  if (!row) return { connected: false }
  return {
    connected: true,
    login: row.login,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    pagesUrl: row.pagesUrl,
    repoUrl:
      row.repoOwner && row.repoName
        ? `https://github.com/${row.repoOwner}/${row.repoName}`
        : null,
  }
}
