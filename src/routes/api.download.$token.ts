import { createFileRoute } from '@tanstack/react-router'
import { eq, sql } from 'drizzle-orm'

import { getDb } from '#/db'
import { entitlements, productAssets } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getEnabledFeatures } from '#/server/features'
import { record } from '#/server/events'
import { readDownloadToken } from '#/server/store/fulfil'

/**
 * Handing over the file.
 *
 * The token in the link says which entitlement and until when, and that is all
 * it says. Everything that decides whether this download may happen is read
 * from the row, right now: whether it was revoked, whether it has expired,
 * whether the count is used up. A link forwarded to a friend therefore stops
 * working when the count runs out, and a refund takes it away without anybody
 * chasing an email.
 *
 * Unauthenticated on purpose. A guest bought this and has no account; the token
 * is the credential, which is why it is a signature over the row and not an id.
 */
export const Route = createFileRoute('/api/download/$token')(
  serverRoute(
    {
      GET: async ({ request, params }) => {
        const env = getEnv(request)
        const db = getDb(env)
        if (!(await getEnabledFeatures(db)).includes('payments')) {
          return new Response('Not found', { status: 404 })
        }

        const id = await readDownloadToken(env, params.token)
        if (!id) return new Response('This link is not valid.', { status: 403 })

        const [right] = await db
          .select()
          .from(entitlements)
          .where(eq(entitlements.id, id))
          .limit(1)
        if (!right) return new Response('Not found', { status: 404 })

        if (right.revokedAt) {
          return new Response('This download was withdrawn.', { status: 410 })
        }
        if (right.expiresAt && right.expiresAt.getTime() < Date.now()) {
          return new Response('This link has expired.', { status: 410 })
        }

        /*
          The count, claimed before the file is sent.

          A conditional update rather than read-then-write: two clicks arriving
          together would both read the same number and both pass. Here the
          database decides, and the second one changes no rows.
        */
        const claimed = await db
          .update(entitlements)
          .set({ downloadsUsed: sql`${entitlements.downloadsUsed} + 1` })
          .where(
            sql`${entitlements.id} = ${id} and ${entitlements.downloadsUsed} < ${entitlements.downloadLimit}`,
          )
          .returning()

        if (!claimed.length) {
          return new Response(
            'This link has been used the maximum number of times.',
            { status: 429 },
          )
        }

        const [asset] = await db
          .select()
          .from(productAssets)
          .where(eq(productAssets.productId, right.productId))
          .limit(1)
        if (!asset) {
          return new Response('That file is not ready yet.', { status: 404 })
        }

        const object = await env.MEDIA.get(asset.objectKey)
        if (!object) {
          return new Response('That file is missing.', { status: 404 })
        }

        await record(db, {
          name: 'product.downloaded',
          subjectType: 'products',
          subjectId: right.productId,
          detail: {
            entitlementId: right.id,
            used: claimed[0]!.downloadsUsed,
            of: right.downloadLimit,
          },
        })

        // Streamed rather than buffered: a 200MB course video must not be
        // held in a Worker's memory on its way past.
        return new Response(object.body as unknown as ReadableStream, {
          headers: {
            'Content-Type': asset.contentType,
            'Content-Disposition': `attachment; filename="${asset.filename.replace(/"/g, '')}"`,
            'Content-Length': String(asset.size),
            // Somebody's purchase. Nothing in between may keep a copy.
            'Cache-Control': 'private, no-store',
          },
        })
      },
    },
    // Exempt from the profile gate: a guest bought this and has no profile.
    { gate: 'none' },
  ),
)
