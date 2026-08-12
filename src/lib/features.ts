/**
 * Which features this node runs.
 *
 * Master is the source of truth for this. At step 5 the value will arrive from
 * master — pushed into the node at provision time and again on every toggle —
 * and this module becomes the single place that reads it. Until then it comes
 * from `VITE_FEATURES` so the gate can be exercised in dev without a code
 * change.
 *
 * Anything gated here must ALSO be gated on the server. Hiding a `<Resource>`
 * only removes the UI; the API routes stay reachable unless they check too.
 */
const configured = import.meta.env.VITE_FEATURES as string | undefined

export const enabledFeatures: Array<string> = (configured ?? 'forms')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean)

export function hasFeature(key: string): boolean {
  return enabledFeatures.includes(key)
}
