import { useEffect, useState } from 'react'

import type { StaticField } from '#/components/static/fields'

export interface StaticCollection {
  name: string
  label: string
  kind: 'files' | 'folder'
  canCreate: boolean
  canDelete: boolean
  slugField?: string
  files?: Array<{
    name: string
    label: string
    file: string
    fields: Array<StaticField>
  }>
  fields: Array<StaticField>
}

/**
 * The site's content model, fetched at runtime.
 *
 * It cannot be known at build time: it lives in the repo the operator connected,
 * and different sites carry different models. One build therefore serves them
 * all, which is the same reason features are read rather than compiled in.
 */
export interface StaticModel {
  collections: Array<StaticCollection>
  /** the published site, which also serves the preview frame */
  siteUrl: string | null
}

let pending: Promise<StaticModel> | null = null

export function loadStaticModel(): Promise<StaticModel> {
  if (!pending) {
    pending = fetch('/api/static')
      .then((response) =>
        response.ok ? response.json() : { collections: [], siteUrl: null },
      )
      .then((body: Partial<StaticModel>) => ({
        collections: body.collections ?? [],
        siteUrl: body.siteUrl ?? null,
      }))
      .catch(() => ({ collections: [], siteUrl: null }))
  }
  return pending
}

export function invalidateStaticModel() {
  pending = null
}

export function useStaticModel(): StaticModel | null {
  const [model, setModel] = useState<StaticModel | null>(null)

  useEffect(() => {
    let cancelled = false
    loadStaticModel().then((result) => {
      if (!cancelled) setModel(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return model
}
