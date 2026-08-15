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
 * **From `/api/permissions`, not from `/api/features`.** The features table is
 * behind `settings:read`, which most roles have no business holding, and asking
 * there meant anybody without it got a 403 and an empty list. Every
 * feature-gated screen then evaluated false, `<Admin>` was left with no
 * children, and react-admin showed its "add a Resource" splash — so a
 * collaborator signed in successfully and arrived at a welcome page with
 * nothing on it.
 *
 * Cached as a single in-flight promise so mounting `<Admin>` twice (the `/` and
 * `/$` routes both render it) does not fetch twice.
 */
let pending: Promise<Array<string>> | null = null

export function loadEnabledFeatures(): Promise<Array<string>> {
  if (!pending) {
    pending = fetch('/api/permissions')
      .then((response) => (response.ok ? response.json() : {}))
      .then((body: { features?: Array<string> }) => body.features ?? [])
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
