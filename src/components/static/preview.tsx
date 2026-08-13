import { useEffect, useRef, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useRecordContext } from 'ra-core'

import { cn } from '#/lib/utils'

/**
 * The page, painted from the form as it is typed.
 *
 * The frame is served by the site itself and uses the site's own renderer, so
 * what appears here is the page rather than a second implementation of it. The
 * panel only sends values; it does not know how anything is drawn.
 *
 * Drafts go over `postMessage` rather than by reloading the frame — a reload on
 * every keystroke would flicker, lose scroll position, and refetch the content
 * files each time.
 */
export const StaticPreview = ({
  collection,
  siteUrl,
}: {
  collection: string
  siteUrl: string
}) => {
  const frame = useRef<HTMLIFrameElement>(null)
  const lastSent = useRef<string>('')
  const record = useRecordContext<{ id: string }>()
  const { control } = useFormContext()
  const values = useWatch({ control })
  const [ready, setReady] = useState(false)
  // Scoped by default: an entry owns a part of the page, and handing back the
  // whole site means hunting for the change that was just made.
  const [mode, setMode] = useState<'entry' | 'page'>('entry')

  const src = `${siteUrl.replace(/\/+$/, '')}/static-admin/admincms-preview.html`
  const origin = (() => {
    try {
      return new URL(src).origin
    } catch {
      return '*'
    }
  })()

  // The frame announces itself once it has fetched the page, so the first draft
  // is not sent into a document that cannot paint it yet.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'admincms:preview-ready') setReady(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (!ready || !frame.current?.contentWindow) return

    const message = {
      type: 'admincms:preview',
      collection,
      id: record?.id,
      mode,
      data: values,
    }

    const serialised = JSON.stringify(message)
    if (serialised === lastSent.current) return
    lastSent.current = serialised

    frame.current.contentWindow.postMessage(message, origin)
  }, [ready, collection, record?.id, values, mode, origin])

  if (!siteUrl) return null

  return (
    // Sticky, because the form beside it is long and the preview is the reason
    // the form is worth filling in — scrolling to a field should not scroll the
    // result off the screen.
    <div className="min-w-0 xl:sticky xl:top-6 xl:self-start">
      <div className="border-border/70 bg-card/60 overflow-hidden rounded-xl border shadow-sm">
        <div className="border-border/70 flex items-center gap-2 border-b px-3 py-2">
          <span
            className={cn(
              'size-1.5 rounded-full transition-colors',
              ready ? 'bg-primary' : 'bg-muted-foreground/40',
            )}
          />
          <span
            className="text-muted-foreground text-[0.7rem] font-semibold tracking-[0.08em] uppercase"
            title={siteUrl}
          >
            {ready ? 'Live preview' : 'Loading the page'}
          </span>
          <div className="border-border/70 ml-auto flex shrink-0 items-center rounded-md border p-0.5">
            {(['entry', 'page'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={cn(
                  'focus-visible:ring-ring/60 rounded-[5px] px-2 py-0.5 text-[0.7rem] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
                  mode === option
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option === 'entry' ? 'This entry' : 'Whole page'}
              </button>
            ))}
          </div>
        </div>
        <iframe
          ref={frame}
          src={src}
          title="Live preview"
          className="bg-background block h-[calc(100vh-12rem)] max-h-[46rem] min-h-[28rem] w-full"
          // The frame is the operator's own site; it needs scripts to render, and
          // same-origin so it can read its own content files.
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  )
}
