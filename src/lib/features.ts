import { useEffect, useState } from 'react'

import { FEATURE_CATALOG } from '#/lib/feature-catalog'

export interface FeatureRow {
  id: number
  key: string
  enabled: boolean
}

/**
 * Reads this node's live feature state.
 *
 * The node decides for itself, so the answer lives in its database and has to
 * be fetched — it cannot be a build-time constant, or a toggle would need a
 * redeploy.
 *
 * Cached as a single in-flight promise so mounting `<Admin>` twice (the `/` and
 * `/$` routes both render it) does not fetch twice.
 */
let pending: Promise<Array<string>> | null = null

export function loadEnabledFeatures(): Promise<Array<string>> {
  if (!pending) {
    pending = fetch('/api/features?range=%5B0%2C99%5D')
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: Array<FeatureRow>) =>
        rows.filter((row) => row.enabled).map((row) => row.key),
      )
      .catch(() => [])
  }
  return pending
}

/** Call after a toggle, so the next read sees the new state. */
export function invalidateFeatures() {
  pending = null
}

export function useEnabledFeatures() {
  const [enabled, setEnabled] = useState<Array<string> | null>(null)

  useEffect(() => {
    let cancelled = false
    loadEnabledFeatures().then((keys) => {
      if (!cancelled) setEnabled(keys)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return enabled
}

/** Catalog entries paired with whether they are currently on. */
export function describeFeatures(enabled: Array<string>) {
  return FEATURE_CATALOG.map((feature) => ({
    ...feature,
    enabled: enabled.includes(feature.key),
  }))
}
