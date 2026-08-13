import { useEffect, useRef, useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { useRecordContext } from 'ra-core'

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
      data: values,
    }

    const serialised = JSON.stringify(message)
    if (serialised === lastSent.current) return
    lastSent.current = serialised

    frame.current.contentWindow.postMessage(message, origin)
  }, [ready, collection, record?.id, values, origin])

  if (!siteUrl) return null

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">Preview</p>
      <iframe
        ref={frame}
        src={src}
        title="Live preview"
        className="bg-background h-[70vh] w-full rounded-md border"
        // The frame is the operator's own site; it needs scripts to render, and
        // same-origin so it can read its own content files.
        sandbox="allow-scripts allow-same-origin"
      />
      {!ready && (
        <p className="text-muted-foreground text-xs">Loading the page…</p>
      )}
    </div>
  )
}
