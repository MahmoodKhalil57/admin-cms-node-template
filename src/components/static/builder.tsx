import { useEffect, useState } from 'react'
import { LayoutTemplate } from 'lucide-react'

import { Button } from '#/components/ui/button'

/**
 * The visual builder, opened over the panel.
 *
 * The same arrangement the site's own editor uses: the builder is a full
 * surface rather than a field on a form, so it takes the whole viewport and
 * hands control back when it closes. Opening it scoped to the entry being
 * edited means the operator lands on the thing they were already looking at
 * instead of on the homepage.
 *
 * It is served by the node at `/admin/builder`, not by the site, so the session
 * cookie reaches the API and the builder commits through the GitHub connection
 * the operator already made.
 */

const OPEN_EVENT = 'admincms:builder-open'

/** `page:<slug>` or `symbol:<id>` — what the builder should open on. */
export function openBuilder(focus?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { focus } }))
}

export const OpenInBuilder = ({ focus }: { focus?: string }) => (
  <Button
    type="button"
    variant="outline"
    size="sm"
    className="w-fit"
    onClick={() => openBuilder(focus)}
  >
    <LayoutTemplate className="size-4" />
    Open in the builder
  </Button>
)

export const BuilderOverlay = () => {
  const [focus, setFocus] = useState<string | null>(null)

  useEffect(() => {
    const open = (event: Event) => {
      setFocus((event as CustomEvent<{ focus?: string }>).detail?.focus ?? '')
    }
    const close = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'pure-builder:close') setFocus(null)
    }
    window.addEventListener(OPEN_EVENT, open)
    window.addEventListener('message', close)
    return () => {
      window.removeEventListener(OPEN_EVENT, open)
      window.removeEventListener('message', close)
    }
  }, [])

  // Escape closes it, because a full-viewport overlay with one Close button is
  // a trap for anyone who reaches for the key first.
  useEffect(() => {
    if (focus === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocus(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus])

  if (focus === null) return null

  const src = focus
    ? `/admin/builder?focus=${encodeURIComponent(focus)}`
    : '/admin/builder'

  return (
    <iframe
      src={src}
      title="Page builder"
      className="fixed inset-0 z-[2000] h-full w-full border-0 bg-[#0c1c21]"
    />
  )
}
