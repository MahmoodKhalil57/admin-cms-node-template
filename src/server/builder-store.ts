import { StaticError, decode, gh } from './static-store'
import type { RepoRef } from './static-store'

/**
 * Repository access for the visual builder.
 *
 * The builder is not a form over one file. A single save rewrites the page
 * drawings, the baked HTML, the stylesheet and the manifests together — and
 * half of that landing is a broken site. So writes go through the git data API
 * as one commit rather than as a file at a time.
 *
 * It reads through here too, rather than from the published site, because the
 * published site is the last deploy and the builder needs what is in the repo
 * now.
 */

function base(ref: RepoRef): string {
  return `/repos/${ref.owner}/${ref.repo}`
}

async function defaultBranch(ref: RepoRef): Promise<string> {
  const res = await gh(ref, 'GET', base(ref))
  if (res.status !== 200) {
    throw new StaticError('Could not read the repository.', res.status)
  }
  return String(res.json.default_branch ?? 'main')
}

export async function readRepoFile(
  ref: RepoRef,
  path: string,
): Promise<string | null> {
  const res = await gh(ref, 'GET', `${base(ref)}/contents/${path}`)
  if (res.status === 404) return null
  if (res.status !== 200) {
    throw new StaticError(`Could not read ${path}.`, res.status)
  }
  return decode(String(res.json.content))
}

/** Every JSON file in a directory, read in full — an entry folder is small. */
export async function listRepoDir(
  ref: RepoRef,
  path: string,
): Promise<Array<{ name: string; path: string; text: string }>> {
  const res = await gh(ref, 'GET', `${base(ref)}/contents/${path}`)
  if (res.status === 404) return []
  if (res.status !== 200) {
    throw new StaticError(`Could not list ${path}.`, res.status)
  }

  const files = (res.json as Array<Record<string, unknown>>).filter(
    (item) => item.type === 'file' && String(item.name).endsWith('.json'),
  )

  return Promise.all(
    files.map(async (item) => ({
      name: String(item.name).replace(/\.json$/, ''),
      path: String(item.path),
      text: (await readRepoFile(ref, String(item.path))) ?? '',
    })),
  )
}

export interface CommitFile {
  path: string
  content: string
}

/**
 * One commit for the whole save: read the branch head, write a tree on top of
 * it, commit, move the ref.
 */
export async function commitFiles(
  ref: RepoRef,
  files: Array<CommitFile>,
  message: string,
): Promise<string> {
  if (!files.length) throw new StaticError('Nothing to commit.', 400)

  const branch = await defaultBranch(ref)

  const head = await gh(ref, 'GET', `${base(ref)}/git/ref/heads/${branch}`)
  if (head.status !== 200) {
    throw new StaticError(`Could not read ${branch}.`, head.status)
  }
  const headSha = String(head.json.object.sha)

  const parent = await gh(ref, 'GET', `${base(ref)}/git/commits/${headSha}`)
  if (parent.status !== 200) {
    throw new StaticError('Could not read the head commit.', parent.status)
  }

  const tree = await gh(ref, 'POST', `${base(ref)}/git/trees`, {
    base_tree: parent.json.tree.sha,
    tree: files.map((file) => ({
      path: file.path,
      mode: '100644',
      type: 'blob',
      content: file.content,
    })),
  })
  if (tree.status !== 201) {
    throw new StaticError(tree.json?.message ?? 'Could not write the tree.', tree.status)
  }

  const commit = await gh(ref, 'POST', `${base(ref)}/git/commits`, {
    message,
    tree: tree.json.sha,
    parents: [headSha],
  })
  if (commit.status !== 201) {
    throw new StaticError(
      commit.json?.message ?? 'Could not create the commit.',
      commit.status,
    )
  }

  const moved = await gh(ref, 'PATCH', `${base(ref)}/git/refs/heads/${branch}`, {
    sha: commit.json.sha,
  })
  if (moved.status !== 200) {
    throw new StaticError(
      moved.json?.message ?? `Could not move ${branch}.`,
      moved.status,
    )
  }

  return String(commit.json.sha)
}
