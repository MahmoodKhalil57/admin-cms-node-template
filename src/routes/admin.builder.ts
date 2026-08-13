import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getAuth } from '#/server/auth'
import { getEnv } from '#/server/env'
import { currentConnection } from '#/server/github-store'
import { getSettings } from '#/server/settings'

/**
 * The visual builder, served by the node.
 *
 * The builder itself lives in the site's repository — it is the same file the
 * site's own editors use, and a site may have changed it. Only the page around
 * it is ours.
 *
 * Serving that page from here rather than linking to the site is what makes the
 * builder work without a second GitHub authorization: the node's session cookie
 * is same-origin with this page, so the builder can reach `/api/builder/*` and
 * commit through the connection the operator already made.
 *
 * It sits under `/admin` rather than at `/builder` because the node's Worker
 * routes are `/admin*` and `/api*`. A new top-level path would need a new route
 * provisioned on every node that already exists; this needs none.
 *
 * GrapesJS is pinned, matching the discipline on the site's own copy — bump
 * both lines together when taking a new release.
 */
const GRAPES = '0.23.5'

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] as string,
  )
}

function page(site: string, focus: string): string {
  const config = JSON.stringify({ api: '', site, focus })
  // The builder is the site's own file, served by GitHub Pages with
  // max-age=600. Loading a stale copy is not cosmetic here: an older builder
  // once wrote symbol entries it should have left alone. Bucket to the minute
  // so a fix reaches every panel quickly.
  const version = Math.floor(Date.now() / 60000)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Page builder</title>
    <link rel="stylesheet" href="https://unpkg.com/grapesjs@${GRAPES}/dist/css/grapes.min.css" />
    <script src="https://unpkg.com/grapesjs@${GRAPES}/dist/grapes.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; font-family: 'Manrope', ui-sans-serif, system-ui, sans-serif; }
      .bar {
        display: flex; gap: 0.6rem; align-items: center; height: 46px;
        padding: 0 0.8rem; background: #0c1c21; color: #d9ece9;
      }
      .bar strong { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; }
      .bar__status {
        flex: 1; overflow: hidden; font-size: 0.8rem; color: #8fb0ae;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .bar__status[data-state="error"] { color: #e0776c; }
      .bar button, .bar select {
        padding: 0.35rem 0.8rem; font: inherit; font-size: 0.8rem; color: #d9ece9;
        cursor: pointer; background: transparent;
        border: 1px solid rgba(141, 229, 219, 0.25); border-radius: 6px;
      }
      .bar button:hover { border-color: #5fd3cb; }
      .bar button[disabled] { cursor: not-allowed; opacity: 0.4; }
      .bar select { background: #12242a; }
      .bar button.bar__save {
        color: #04231f; background: #5fd3cb; border-color: #5fd3cb; font-weight: 600;
      }
      #gjs { height: calc(100% - 46px); border: 0; }
    </style>
  </head>
  <body>
    <header class="bar">
      <strong>Page builder</strong>
      <span class="bar__status" id="status">Loading…</span>
      <select id="page-select" title="Switch page" hidden></select>
      <button id="make-symbol" title="Make the selected element reusable — edits sync everywhere">Make reusable</button>
      <button id="save-block" title="Save a copy of the selected element as a starter block">Save block</button>
      <button id="connect-local" hidden></button>
      <button id="connect-github" hidden></button>
      <button id="close">Close</button>
      <button class="bar__save" id="save" disabled>Save</button>
    </header>

    <div id="gjs"></div>

    <script>
      window.__ADMINCMS_BUILDER__ = ${config};
      document.getElementById('close').addEventListener('click', function () {
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'pure-builder:close' }, window.location.origin);
        }
      });
    </script>
    <script src="${escapeHtml(site)}/assets/js/render.js?v=${version}"></script>
    <script src="${escapeHtml(site)}/static-admin/builder.js?v=${version}"></script>
  </body>
</html>`
}

export const Route = createFileRoute('/admin/builder')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      if (!(await getAuth(env).api.getSession({ headers: request.headers }))) {
        return new Response('Unauthorized', { status: 401 })
      }

      const db = getDb(env)
      const connection = await currentConnection(db)
      const settings = await getSettings(db)
      // Same preference as the preview: on the custom domain the site, the
      // panel and the API share an origin, so nothing has to cross one.
      const site = (
        settings.customDomain && settings.frontendVerified
          ? `https://${settings.customDomain}`
          : (connection?.pagesUrl ?? '')
      ).replace(/\/+$/, '')
      if (!site) {
        return new Response(
          'Connect GitHub and publish a site before opening the builder.',
          { status: 400, headers: { 'Content-Type': 'text/plain' } },
        )
      }

      const focus = new URL(request.url).searchParams.get('focus') ?? ''

      return new Response(page(site, focus), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    },
  }),
)
